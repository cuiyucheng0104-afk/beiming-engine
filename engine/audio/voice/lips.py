# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 口型提示：每帧的开口度 + 每个音节的起止帧与口型类别，给画面里的人物张嘴闭嘴用。

craft/animation.md §6「对白与口型不同步」：口型比声音提前 1–2 帧（lead，默认 1 帧）、长元音保持、不必每个字都开合、一拍二出口型（step）。
  open_curve(audio, sr, fps, lead=1, floor_db=-36, step=1) → [0..1, …]  每帧开口度：10 ms 均方根包络，按这句的 95 分位归一，
                                                     低于 floor_db 记 0（闭嘴）；起音立刻张开、收尾按 1 帧释放；整体提前 lead 帧
  viseme(unit) → 'M' | 'F' | 'O' | 'I' | 'A' | 'rest'
                 拉丁字母按首字母与主元音粗分：b/p/m 闭唇 M、f/v 唇齿 F、o/u 圆唇 O、i/e 扁唇 I、其余张口 A；
                 汉字没有读音表时一律 A（只给开合，粗同步）；要音素级口型，在 dialogue.json 的台词里写 visemes 覆盖
  syllables(units_timed, fps, lead=1) → [[字, 起帧, 止帧, 口型], …]   标点记 rest
"""
import numpy as np

_VOWEL_O = set('oOuUwW')
_VOWEL_I = set('iIeEyY')


def open_curve(audio, sr, fps, lead=1, floor_db=-36.0, step=1):
    x = np.asarray(audio, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if not len(x):
        return []
    h = max(1, int(round(sr * 0.01)))
    m = int(np.ceil(len(x) / h))
    pad = np.zeros(m * h)
    pad[:len(x)] = x
    e = np.sqrt(np.mean(pad.reshape(m, h) ** 2, axis=1))
    ref = float(np.percentile(e[e > 0], 95)) if (e > 0).any() else 0.0
    if ref <= 1e-9:
        return [0.0] * int(np.ceil(len(x) / sr * fps))
    d = 20 * np.log10(np.maximum(e / ref, 1e-9))
    o = np.clip((d - floor_db) / -floor_db, 0.0, 1.0)
    n = int(np.ceil(len(x) / sr * fps))
    fr = np.zeros(n)
    per = 100.0 / fps                                   # 每帧多少个 10 ms 块
    for i in range(n):
        a, b = int(i * per), max(int(i * per) + 1, int((i + 1) * per))
        fr[i] = o[a:b].max() if a < len(o) else 0.0
    out = np.zeros(n)
    v = 0.0
    for i in range(n):
        v = fr[i] if fr[i] >= v else 0.5 * v + 0.5 * fr[i]   # 立刻张开、收尾 1 帧左右释放
        out[i] = v
    if step > 1:
        out = np.repeat(out[::step], step)[:n]
    if lead > 0:
        out = np.concatenate([out[lead:], np.zeros(lead)])
    return [round(float(v), 3) for v in out]


def viseme(text):
    if not text:
        return 'rest'
    c = text[0]
    if not c.isascii():
        return 'A'
    lo = text.lower()
    if lo[0] in 'bpm':
        return 'M'
    if lo[0] in 'fv':
        return 'F'
    vowels = [ch for ch in lo if ch in 'aeiouy']
    if not vowels:
        return 'A'
    v = vowels[0]
    return 'O' if v in 'ouw' else ('I' if v in 'iey' else 'A')


def syllables(units_timed, kinds, fps, lead=1):
    out = []
    for (u, a, b), k in zip(units_timed, kinds):
        f0 = max(0, int(np.floor(a * fps + 1e-6)) - lead)
        f1 = max(f0 + 1, int(np.ceil(b * fps - 1e-6)) - lead)
        out.append([u, f0, f1, 'rest' if k == 'punct' else viseme(u)])
    return out
