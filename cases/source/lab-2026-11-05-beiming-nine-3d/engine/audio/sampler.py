# -*- coding: utf-8 -*-
"""北冥引擎 · 采样器：从多采样乐器库里取音、移调、延长、包络。

采样库不随仓库分发，内置乐器表指向两套 CC0（公有领域）库：
  VSCO 2 Community Edition（Versilian Studios）、Versilian Community Sample Library（VCSL）。
把它们放在同一个目录下（vsco2ce/、vcsl/ 两个子目录），用环境变量 BEIMING_SAMPLES 指过去，或由调用方设 ROOT。
别的乐器：INSTRUMENTS[名字] = (相对 ROOT 的目录, 'sus' 可延长长音 / 'dec' 自然衰减 / 'hit' 无音高, 默认释音秒)。

接口：
  seed(n)                                   重置轮换随机（同一调用顺序 → 同一结果）
  midi('D#4') / midi(62.05)                 音名 → MIDI（允许小数 = 微分音）
  note(inst, pitch, dur, vel, release, attack) 一个音：返回单声道 float32，长度 ≈ dur + release
  hit(inst, name, vel, dur)                 无音高打击乐（按文件名里的关键字选，如 'cresc'）
  credits(used)                             署名行
"""
import os
import re
import glob

import numpy as np
import soundfile as sf
import soxr

from .dsp import SR

ROOT = os.environ.get('BEIMING_SAMPLES', '')

INSTRUMENTS = {
    'violins':          ('vsco2ce/Strings/Violin Section/susVib', 'sus', 0.35),
    'violas':           ('vsco2ce/Strings/Viola Section/susvib', 'sus', 0.35),
    'cellos':           ('vsco2ce/Strings/Cello Section/susvib', 'sus', 0.40),
    'contrabass':       ('vsco2ce/Strings/Solo Contrabass/SusVib', 'sus', 0.40),
    'horn':             ('vsco2ce/Brass/F Horn/sus', 'sus', 0.35),
    'harp':             ('vcsl/Chordophones/Composite Chordophones/Concert Harp', 'dec', 1.2),
    'glockenspiel':     ('vcsl/Idiophones/Struck Idiophones/Glockenspiel', 'dec', 1.5),
    'vibraphone_bowed': ('vcsl/Idiophones/Struck Idiophones/Vibraphone/Bowed', 'sus', 1.0),
    'sus_cymbal':       ('vcsl/Idiophones/Struck Idiophones/Suspended Cymbal 1', 'hit', 0.5),
}

_rng = np.random.default_rng(2026)
_cache = {}


def seed(n):
    global _rng
    _rng = np.random.default_rng(n)


_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def midi(p):
    if isinstance(p, (int, float, np.integer, np.floating)):
        return float(p)
    m = re.fullmatch(r'\s*([A-Ga-g])([#b]?)(-?\d+)\s*', str(p))
    if not m:
        raise ValueError(f'无法解析音高 {p!r}')
    acc = {'#': 1, 'b': -1}.get(m.group(2), 0)
    return float(12 * (int(m.group(3)) + 1) + _PC[m.group(1).upper()] + acc)


# —— 力度：文件名里的力度记号 → 0..1 ——
_DYN = {'pp': 0.15, 'p': 0.3, 'soft': 0.3, 'mp': 0.45, 'medium': 0.55, 'mf': 0.6, 'f': 0.75, 'loud': 0.8, 'ff': 0.88, 'fff': 1.0}


def _velocity(tokens):
    for t in tokens:
        m = re.fullmatch(r'v(\d)', t)
        if m:
            return int(m.group(1))            # v1..v5：相对层级，稍后归一化
        d = re.fullmatch(r'([a-z]+?)\d*', t)
        if d and d.group(1) in _DYN:
            return _DYN[d.group(1)] * 10
    return 5


def _zones(inst):
    """扫一件乐器的所有采样：[{file, midi, vel, stem}]，vel 归一化到 0..1"""
    if inst in _cache:
        return _cache[inst]
    rel, kind, _ = INSTRUMENTS[inst]
    files = sorted(glob.glob(os.path.join(ROOT, rel, '**', '*.flac'), recursive=True)
                   + glob.glob(os.path.join(ROOT, rel, '**', '*.wav'), recursive=True))
    if not files:
        raise FileNotFoundError(f'找不到 {inst} 的采样：{os.path.join(ROOT, rel)}（检查 BEIMING_SAMPLES）')
    zones = []
    for f in files:
        stem = os.path.splitext(os.path.basename(f))[0]
        tokens = re.split(r'[_\s\-]+', stem)
        note = next((t for t in tokens if re.fullmatch(r'[A-G]#?-?\d', t)), None)
        if kind != 'hit' and note is None:
            continue
        zones.append({'file': f, 'stem': stem.lower(), 'midi': midi(note) if note else None,
                      'vel': _velocity([t.lower() for t in tokens])})
    vs = sorted({z['vel'] for z in zones})
    for z in zones:
        z['vel'] = 0.5 if len(vs) == 1 else vs.index(z['vel']) / (len(vs) - 1)
    _cache[inst] = zones
    return zones


def _read(path):
    key = ('audio', path)
    if key not in _cache:
        x, sr = sf.read(path, dtype='float32', always_2d=True)
        x = x.mean(axis=1)
        if sr != SR:
            x = soxr.resample(x, sr, SR, quality='HQ')
        peak = np.abs(x).max() or 1.0
        on = int(np.argmax(np.abs(x) > 0.02 * peak))     # 起音：第一处超过峰值 2% 的位置，再提前 5 ms
        _cache[key] = x[max(0, on - SR // 200):]
    return _cache[key]


def _pick(zones, m, vel):
    """最近音高；同音高里取最近力度；同分时随机轮换"""
    dp = min(abs(z['midi'] - m) for z in zones)
    near = [z for z in zones if abs(z['midi'] - m) - dp < 0.51]
    dv = min(abs(z['vel'] - vel) for z in near)
    cand = [z for z in near if abs(z['vel'] - vel) - dv < 1e-6]
    return cand[int(_rng.integers(len(cand)))]


def _extend(x, n, xf=0.15):
    """长音不够长：取中段反复交叉淡化接上，直到 n 个采样"""
    if len(x) >= n:
        return x[:n]
    a, b = int(len(x) * 0.35), int(len(x) * 0.85)
    loop, c = x[a:b], int(min(xf * SR, (b - a) * 0.4))
    out = x[:b].copy()
    fin, fout = np.sin(np.linspace(0, np.pi / 2, c)) ** 2, np.cos(np.linspace(0, np.pi / 2, c)) ** 2
    while len(out) < n:
        out[-c:] = out[-c:] * fout + loop[:c] * fin
        out = np.concatenate([out, loop[c:]])
    return out[:n]


def _envelope(x, dur, attack, release):
    n_on, n_rel = int(dur * SR), int(release * SR)
    y = x[:n_on + n_rel].astype(np.float32).copy()
    if attack > 0:
        k = min(len(y), int(attack * SR))
        y[:k] *= (np.sin(np.linspace(0, np.pi / 2, k)) ** 2).astype(np.float32)
    if n_rel > 0 and len(y) > n_on:
        k = len(y) - n_on
        y[n_on:] *= (np.cos(np.linspace(0, np.pi / 2, k)) ** 2).astype(np.float32)
    return y


def note(inst, pitch, dur, vel=0.8, release=None, attack=0.0):
    rel, kind, rel_default = INSTRUMENTS[inst]
    release = rel_default if release is None else release
    m = midi(pitch)
    z = _pick(_zones(inst), m, vel)
    x = _read(z['file'])
    semis = m - z['midi']
    if abs(semis) > 1e-3:   # 移调 = 按 2^(半音/12) 改变播放速度
        x = soxr.resample(x, SR * 2 ** (semis / 12), SR, quality='HQ').astype(np.float32)
    need = int((dur + release) * SR)
    x = _extend(x, need) if kind == 'sus' else np.pad(x, (0, max(0, need - len(x))))
    return _envelope(x, dur, attack, release) * (0.4 + 0.6 * vel)


def hit(inst, name=None, vel=0.8, dur=None):
    zones = [z for z in _zones(inst) if name is None or str(name).lower() in z['stem']]
    if not zones:
        raise ValueError(f'{inst} 里没有包含 {name!r} 的采样')
    dv = min(abs(z['vel'] - vel) for z in zones)
    cand = [z for z in zones if abs(z['vel'] - vel) - dv < 1e-6]
    x = _read(cand[int(_rng.integers(len(cand)))]['file']).copy()
    if dur is not None and len(x) > int(dur * SR):
        x = _envelope(x, dur, 0.0, 0.03)
    return x


def credits(used):
    vsco = any(INSTRUMENTS[u][0].startswith('vsco2ce') for u in used)
    vcsl = any(INSTRUMENTS[u][0].startswith('vcsl') for u in used)
    libs = [n for n, ok in [('VS Chamber Orchestra: Community Edition (Versilian Studios)', vsco),
                            ('Versilian Community Sample Library (Versilian Studios)', vcsl)] if ok]
    return ['Samples (CC0): ' + ', '.join(libs)]
