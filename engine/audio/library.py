# -*- coding: utf-8 -*-
"""北冥引擎 · 真实录音库：按清单取 CC0 录音，统一成 48 kHz 立体声，再裁剪、循环、移调。

清单 audio/sfx_manifest.json：{"sounds": {名字: {"id": Freesound 编号, "start": 秒, "len": 秒, "semitones": 半音,
  "lp": Hz, "hp": Hz, "env": [[秒, 增益], ...], "fade_out": 秒, "title": .., "author": ..}}}；录音放在 <目录>/<id>.* 。
没调用 use() / use_manifest() 时库是空的：get / file 返回 None，调用方照旧走程序化合成。
名字在清单里但文件不在，直接报错（不静默回退，免得误以为听的是真实录音）。

接口：
  use(清单路径, 录音目录) / use_manifest(清单字典, 录音目录)   启用
  get(名字, dur=None, mono=False)    一段录音：dur=None 是一次性音效（自动裁掉开头静音），给秒数则铺成正好这么长的底噪（不够就等功率交叉循环）
  file(名字) / slices(路径)          鸽翼这类“一下一下”的事件：文件路径、切出的短事件列表
  credits()                          用到的录音署名行
"""
import glob
import json
import os

import numpy as np
import soundfile as sf
import soxr

from .dsp import SR, N, fade, curve, lp, hp

_M = {}
_DIR = ''
_cache = {}
_slices = {}
USED = set()


def use(manifest_path, sample_dir):
    with open(manifest_path, encoding='utf-8') as f:
        use_manifest(json.load(f)['sounds'], sample_dir)


def use_manifest(sounds, sample_dir):
    global _M, _DIR
    _M, _DIR = sounds, sample_dir
    _cache.clear()
    _slices.clear()
    USED.clear()


def active():
    return bool(_M)


def file(name):
    if name not in _M:
        return None
    hits = sorted(glob.glob(os.path.join(_DIR, f"{_M[name]['id']}.*")))
    if not hits:
        raise FileNotFoundError(f"缺少录音 {name}（Freesound {_M[name]['id']}），先运行 node tools/env/py.mjs tools/fetch_sfx.py")
    USED.add(name)
    return hits[0]


def load(path):
    if path not in _cache:
        x, rate = sf.read(path, dtype='float64', always_2d=True)
        if len(x) == 0 or not np.any(x):
            raise ValueError(f'空文件或全静音：{path}')
        x = np.repeat(x, 2, 1) if x.shape[1] == 1 else x[:, :2]
        _cache[path] = soxr.resample(x, rate, SR) if rate != SR else x
    return _cache[path]


def slices(path, max_len=0.12, gate=0.12):
    """按 5 ms 包络的门限切出一下一下的短事件（单声道，原始幅度）；单段封顶 max_len 秒，连续噪声也不会糊成一整段"""
    if path not in _slices:
        x = load(path).mean(1)
        win = N(0.005)
        env = np.sqrt(np.convolve(x * x, np.ones(win) / win, 'same'))
        edges = np.flatnonzero(np.diff(np.r_[False, env > env.max() * gate, False])).reshape(-1, 2)
        out = []
        for a, b in edges:
            if b - a >= N(0.025):
                a = max(0, a - N(0.015))
                out.append(x[a:min(len(x), b + N(0.025), a + N(max_len))])
        if not out:
            a = max(0, int(np.argmax(env)) - N(0.015))
            out.append(x[a:a + N(max_len)])
        _slices[path] = out
    return _slices[path]


def _fit(x, n):
    """铺到正好 n 个样本；不够就首尾等功率交叉循环（0.25 s）"""
    xf = min(N(0.25), len(x) // 2)
    t = np.linspace(0, np.pi / 2, xf)[:, None]
    while len(x) < n:
        x = np.concatenate([x[:-xf], x[-xf:] * np.cos(t) + x[:xf] * np.sin(t), x[xf:]]) if xf else np.concatenate([x, x])
    return x[:n]


def get(name, dur=None, mono=False):
    m = _M.get(name)
    if m is None:
        return None
    x = load(file(name))
    a = N(m.get('start', 0))
    x = x[a:a + N(m['len'])] if 'len' in m else x[a:]
    if not len(x):
        raise ValueError(f'{name}: start/len 超出录音范围')
    if dur is None:
        peak = np.abs(x).max()
        i = int(np.argmax(np.abs(x).max(1) > 0.05 * peak))
        x = x[max(0, i - N(0.005)):]
    if 'semitones' in m:
        x = soxr.resample(x, SR * 2 ** (m['semitones'] / 12), SR)
    if dur is not None:
        x = _fit(x, N(dur))
    if 'lp' in m:
        x = lp(x, m['lp'], 2)
    if 'hp' in m:
        x = hp(x, m['hp'], 2)
    x = fade(x, 0.005, m.get('fade_out', 0.03))
    if 'env' in m:
        x = x * curve(m['env'], np.arange(len(x)) / SR)[:, None]
    return x.mean(1) if mono else x


def credits():
    return [f"{n}: {_M[n].get('title', '')} — {_M[n].get('author', '')} (https://freesound.org/s/{_M[n]['id']}/, CC0)"
            for n in sorted(USED)]
