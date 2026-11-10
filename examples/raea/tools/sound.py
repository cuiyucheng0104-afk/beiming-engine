# -*- coding: utf-8 -*-
"""《北冥》10 秒原生例片的声音：环境声与摆位、混音、响度都用 engine/audio，只在这里写这部片子的声音事件。

事件时刻一律读 film.json 的 events（帧号 ÷ 帧率）——画面与声音同一个帧号，改一处两边一起动（film.board 是给人看的同一张表）：
  horn      船笛          第一镜，渡船在画面中下方前行
  kun-call  鲲鸣          第二镜开始，鲲眼近景（三次回声）
  blink     细小铃音      鲲眼睑完全闭合的那一帧
  chord     弓弦和弦      第二镜末尾进入，带着最后的大全景收尾
  title     玻璃铃两声    片名「北」起笔一声，「冥」起笔（+0.40 秒，与 title/title.js 的 SPAN 一致）再一声
由 engine/native/prepare.mjs 调用（PYTHONPATH 指向仓库根，BNE_OUT 输出 wav，BNE_DUR 时长，BNE_FILM 作品目录）。
  风 / 水面      engine.audio.ambience.wind('far') / water('far')
  船笛 / 鲲鸣    片中特有的下行谐波与低频共鸣，用 dsp 的时间轴与摆位
  弓弦和弦       四音加法合成
  铃音           engine.audio.synth.glass_tone
  母带           engine.audio.mixing.loudness_to（−14 LUFS，真峰值限制在 −1.5 dBTP）；渲染入口 engine/render/native.mjs
                 再按实测做纯线性增益核对（交付档位要更低的响度，例如 broadcast 的 −23 LUFS，也只是线性降增益）
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from engine.audio import ambience, dsp, mixing, synth  # noqa: E402

FILM = Path(os.environ.get('BNE_FILM', Path(__file__).resolve().parents[1]))
SPEC = json.loads((FILM / 'film.json').read_text(encoding='utf-8'))
EV = {e['id']: e['frame'] / SPEC['fps'] for e in SPEC['events']}
D = float(os.environ.get('BNE_DUR', SPEC['dur']))
OUT = Path(os.environ.get('BNE_OUT', FILM / 'media' / 'mix.wav'))
SR, n = dsp.SR, dsp.N(D)
t = dsp.T(D)
r = dsp.rng(20261106)
EQ = np.sqrt(.5)  # 原稿摆位律居中为 √½，engine 的 pan_lr 居中为 1：事件增益乘 √½ 保持原来的相对电平
y = np.zeros((n, 2))

# 风与水面：engine 的程序化环境声，按原稿的均方根电平放进来
wind, _ = ambience.wind(D, 20261106, 'far')
y += wind * .0112
y += ambience.water(D, 20261107, 'far') * .0012

# 渡船船笛：开场一声缓降的谐波气息
u = dsp.T(1.8)
fr = 146.83 + 7 * np.exp(-u * 6); ph = 2 * np.pi * np.cumsum(fr) / SR
horn = (np.sin(ph) + .25 * np.sin(2 * ph) + .10 * np.sin(3 * ph)) * np.sin(np.pi * u / 1.8) ** 1.3
dsp.place(y, horn, EV['horn'], .11 * EQ, -.35)

# 鲲鸣：眼部近景的低频共鸣，不做尖利的合成吼声；三次延迟回声
u = dsp.T(3.1)
fr = 84 - 18 * u / 3.1 + 3 * np.sin(u * 2.3); ph = 2 * np.pi * np.cumsum(fr) / SR
body = (np.sin(ph) + .27 * np.sin(ph * 2) + .11 * np.sin(ph * 3.01)) * np.sin(np.pi * u / 3.1) ** 1.5
dsp.place(y, body, EV['kun-call'], .16 * EQ, .2)
for delay, g in [(.23, .18), (.61, .10), (.93, .06)]:
    dsp.place(y, body, EV['kun-call'] + delay, g * .16 * EQ, -.3)

# 克制的弓弦和弦随最后的大全景进入，带着收尾
u = dsp.T(4.1)
env = np.minimum(1, u / .95) * (1 - np.clip((u - 2.9) / 1.2, 0, 1))
for k, f0 in enumerate([146.832, 220, 293.665, 369.994]):
    a = sum((.72 ** h) / (h + 1) * np.sin(2 * np.pi * f0 * (h + 1) * u + .003 * np.sin(u * 5.7)) for h in range(5))
    dsp.place(y, a * env, EV['chord'], .032 * EQ, -.55 + k * .36)

# 铃：眼睑闭合时一声细小的高铃（鲲眼在画面右侧，略偏右）；片名两个字起笔各一声（片名在画面左上，偏左）
dsp.place(y, synth.glass_tone(1174.66, 1.2, decay=.22, octave=.12), EV['blink'], .016 * EQ, .25)
for k, (f0, g) in enumerate([(587.33, .025), (880, .022)]):
    dsp.place(y, synth.glass_tone(f0, 1.7, decay=.28, octave=.18), EV['title'] + .40 * k, g * EQ, -.45 + .15 * k)

y = dsp.fade(y, .25, .65)
y, gain, _ = mixing.loudness_to(y, -14.0, -1.5)
OUT.parent.mkdir(parents=True, exist_ok=True)
sf.write(OUT, y, SR, subtype='PCM_24')
print(f'{OUT}  {D:.2f}s  事件 ' + ' '.join(f'{k}={v:.3f}s' for k, v in EV.items()) + f'  总增益 {gain:+.1f} dB')
