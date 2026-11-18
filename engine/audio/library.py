# -*- coding: utf-8 -*-
"""北冥引擎 · 真实录音库：按清单取 CC0 录音，统一成 48 kHz 立体声，再裁剪、循环、移调与感知冲击锚点（P-Center）标定。

清单 audio/sfx_manifest.json：{"sounds": {名字: {"id": Freesound 编号, "start": 秒, "len": 秒, "semitones": 半音,
  "lp": Hz, "hp": Hz, "env": [[秒, 增益], ...], "fade_out": 秒, "anchor": 秒, "de_room": bool, "title": .., "author": ..}}}；
  录音放在 <目录>/<id>.*（同名存在多种格式时优先无损 .wav / .flac）。
没调用 use() / use_manifest() 时库是空的：get / file 返回 None，调用方照旧走程序化合成。
名字在清单里但文件不在，直接报错（不静默回退，免得误以为听的是真实录音）。

接口：
  use(清单路径, 录音目录) / use_manifest(清单字典, 录音目录)   启用
  get(名字, dur=None, mono=False)         一段录音：dur=None 是一次性音效（自动裁掉开头静音），给秒数则铺成正好这么长的底噪
  get_anchored(名字, mono=False)          返回 (音频, 感知锚点秒)：带前导挥动/摩擦的真实录音按感知中心对齐画面冲击帧
  sync_anchor(x, sr=SR)                   计算信号的感知冲击中心（P-Center / Perceptual Attack Time，秒）
  file(名字) / slices(路径)               鸽翼这类“一下一下”的事件：文件路径、切出的短事件列表（过零点回溯 + 自然谷值收尾）
  credits()                               用到的录音署名行
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
_EXT_RANK = {'.wav': 0, '.flac': 1, '.ogg': 2, '.mp3': 3, '.m4a': 4}


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
    hits = sorted(
        glob.glob(os.path.join(_DIR, f"{_M[name]['id']}.*")),
        key=lambda p: (_EXT_RANK.get(os.path.splitext(p)[1].lower(), 9), p),
    )
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


def _zero_cross_back(x, idx, max_back):
    """在 [max(0, idx - max_back), idx] 里找最接近 0 的过零点，避免切片起点咔嗒。"""
    lo = max(0, idx - max_back)
    if idx <= lo + 1:
        return lo
    seg = x[lo:idx + 1]
    zc = np.flatnonzero(seg[:-1] * seg[1:] <= 0)
    if len(zc):
        return lo + int(zc[-1]) + 1
    return lo + int(np.argmin(np.abs(seg)))


def slices(path, max_len=0.12, gate=0.12, min_len=0.025):
    """按 5 ms 包络的门限切出一下一下的短事件（单声道，原始幅度）；单段封顶 max_len 秒，过零点起切并在能量谷平滑收尾。
    对圆珠笔咔嗒、机械怀表擒纵等亚 20 ms 微瞬态可传 min_len=0.0025。"""
    key = (path, float(max_len), float(gate), float(min_len))
    if key not in _slices:
        x = load(path).mean(1)
        win = max(4, N(0.005))
        env = np.sqrt(np.convolve(x * x, np.ones(win) / win, 'same'))
        edges = np.flatnonzero(np.diff(np.r_[False, env > env.max() * gate, False])).reshape(-1, 2)
        out = []
        cap = N(max_len)
        zc_win = max(2, N(0.002))
        min_n = max(6, N(min_len))
        for a, b in edges:
            if b - a >= min_n:
                a0 = _zero_cross_back(x, max(0, a - N(0.012)), zc_win)
                lim = min(len(x), a0 + cap)
                end_cand = min(lim, b + N(0.030))
                if end_cand > b + 4:
                    tail_env = env[b:end_cand]
                    valley = np.flatnonzero(tail_env <= 0.06 * env[a:b].max())
                    if len(valley):
                        end_cand = min(end_cand, b + int(valley[0]) + N(0.006))
                seg = x[a0:max(a0 + 8, min(lim, end_cand))].copy()
                if len(seg) >= N(0.012):
                    seg = fade(seg, min(0.0015, len(seg) / SR * 0.15), min(0.006, len(seg) / SR * 0.25))
                out.append(seg[:cap])
        if not out:
            a0 = _zero_cross_back(x, max(0, int(np.argmax(env)) - N(0.012)), zc_win)
            seg = x[a0:a0 + cap].copy()
            if len(seg) >= N(0.012):
                seg = fade(seg, 0.0015, 0.006)
            out.append(seg)
        _slices[key] = out
    return _slices[key]


def sync_anchor(x, sr=SR):
    """计算音效的感知中心（P-Center / Perceptual Attack Time，秒）：
    结合宽频能量与高频瞬态加权（对应人耳 1.2–5 kHz 瞬态敏感区，Morton 1976 / Scott 1998），
    定位主冲击峰前起音斜率平方加权质心。瞬态点击误差 < 1.5 ms；带前导挥剑风声+落点撞击的复合录音精准落在实际撞击处。"""
    m = x.mean(axis=1) if np.ndim(x) == 2 else np.asarray(x, dtype=float)
    n = len(m)
    if n < 8 or float(np.max(np.abs(m))) < 1e-12:
        return 0.0
    d = np.diff(m, prepend=m[0])
    hf_scale = sr / (2.0 * np.pi * 1200.0)
    p = 0.35 * (m * m) + 0.65 * ((d * hf_scale) ** 2)
    win = max(8, int(round(sr * 0.0025)))
    hop = max(1, int(round(sr * 0.0005)))
    if n <= win:
        return float(np.argmax(np.abs(m))) / sr
    cs = np.concatenate([[0.0], np.cumsum(p)])
    k_cnt = (n - win) // hop + 1
    starts = np.arange(k_cnt) * hop
    env = np.sqrt((cs[starts + win] - cs[starts]) / win)
    emax = float(env.max())
    if emax <= 1e-15:
        return 0.0
    # 找第一个达到主峰 72% 以上的显著局部峰（避免长混响尾音里的次生起伏抢走第一击锚点）
    look_nb = max(1, int(round(0.008 * sr / hop)))
    k_pk = int(np.argmax(env))
    for k in range(k_cnt):
        if env[k] >= 0.72 * emax:
            hi = min(k_cnt, k + look_nb + 1)
            if env[k] >= env[k:hi].max() - 1e-12:
                k_pk = k
                break
    slope = np.maximum(0.0, np.diff(env[:k_pk + 1], prepend=0.0))
    if slope.max() <= 1e-15:
        return float(starts[k_pk] + win * 0.5) / sr
    k_ms = int(np.argmax(slope))
    rad = max(2, int(round(0.010 * sr / hop)))
    lo, hi = max(0, k_ms - rad), min(len(slope), k_ms + rad + 1)
    w = slope[lo:hi] ** 2
    w_sum = float(w.sum())
    k_anchor = (float(np.dot(np.arange(lo, hi), w)) / w_sum) if w_sum > 0 else float(k_ms)
    # 窗中心换算回阶跃信号真实起点（与 cuecheck.measure_onset 一致的窗几何修正）
    t = (k_anchor * hop + 0.85 * win) / sr
    return float(np.clip(t, 0.0, (n - 1) / sr))


def de_room_gate(x, ratio=2.5):
    """轻柔底噪门：从最安静的 20 ms 窗估计录音底噪，对低于 ratio×底噪 的静止段做平滑扩展，不伤瞬态。"""
    m = x.mean(axis=1) if x.ndim == 2 else x
    win = max(16, N(0.020))
    if len(m) < win * 3:
        return x
    cs = np.concatenate([[0.0], np.cumsum(m * m)])
    step = max(1, win // 4)
    idx = np.arange(0, len(m) - win + 1, step)
    rms_w = np.sqrt((cs[idx + win] - cs[idx]) / win)
    floor = float(np.percentile(rms_w, 10))
    if floor <= 1e-7 or floor >= 0.25 * float(rms_w.max()):
        return x
    sm = max(8, N(0.008))
    env = np.sqrt(np.convolve(m * m, np.ones(sm) / sm, 'same') + 1e-24)
    thr = floor * ratio
    g = np.clip((env - floor * 0.8) / max(thr - floor * 0.8, 1e-12), 0.08, 1.0) ** 1.5
    return x * (g[:, None] if x.ndim == 2 else g)


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
    if m.get('de_room'):
        x = de_room_gate(x)
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


def get_anchored(name, mono=False):
    """取一次性真实音效及其感知冲击锚点 (x, anchor_sec)；不在清单里返回 (None, 0.0)。"""
    x = get(name, dur=None, mono=mono)
    if x is None:
        return None, 0.0
    m = _M.get(name, {})
    if 'anchor' in m and m['anchor'] is not None:
        return x, float(m['anchor'])
    return x, sync_anchor(x, SR)


def _nearest_zero(m: np.ndarray, idx: int, rad: int) -> int:
    lo = max(0, idx - rad)
    hi = min(len(m), idx + rad + 1)
    if hi <= lo:
        return int(np.clip(idx, 0, len(m)))
    return int(lo + np.argmin(np.abs(m[lo:hi])))


def load_slice(src, t0: float = 0.0, t1: float = None, *, target_peak: float = 0.95,
               max_gain_db: float = 20.0, max_out_floor_dbfs: float = -56.0,
               floor_win: float = 0.020, on_fail: str = 'raise'):
    """洁净增益取证切片加载（Clean-Gain Forensic Slice Loader）：
    防止把低振幅静止段/轻擦段（如 raw_pk=0.0025~0.048）经峰值归一化硬放大 +26~+52 dB 变成白噪嘶声。
    测量切片原始峰值 raw_pk、所需归一化增益 gain_db = 20·log10(target_peak/raw_pk) 与安静窗底噪 floor_dbfs；
    若 gain_db > max_gain_db 或 floor_dbfs + gain_db > max_out_floor_dbfs：
      · on_fail='raise' 时抛 ValueError；on_fail='none' 时返回 (None, info)。
    通过时返回过零对齐并归一化到 target_peak 的 (单声道波形, info)。"""
    raw = load(src) if isinstance(src, str) else np.asarray(src, dtype=float)
    m_full = raw.mean(axis=1) if raw.ndim == 2 else raw.astype(float, copy=False)
    if len(m_full) == 0:
        info = {'ok': False, 'reason': 'empty', 'raw_pk': 0.0, 'gain_db': np.inf,
                'floor_dbfs': -120.0, 'out_floor_dbfs': np.inf}
        if on_fail == 'raise':
            raise ValueError('load_slice: 输入音频为空')
        return None, info

    rad = max(1, N(0.002))
    i0 = _nearest_zero(m_full, max(0, N(float(t0))), rad) if t0 > 0 else 0
    i1 = _nearest_zero(m_full, min(len(m_full), N(float(t1))), rad) if t1 is not None else len(m_full)
    if i1 <= i0 + 8:
        i1 = min(len(m_full), i0 + max(16, N(0.005)))
    seg = m_full[i0:i1].copy()
    raw_pk = float(np.max(np.abs(seg))) if len(seg) else 0.0
    gain_db = float(20.0 * np.log10(max(target_peak, 1e-6) / max(raw_pk, 1e-12))) if raw_pk > 0 else np.inf

    win = max(16, N(float(floor_win)))
    probe = seg if len(seg) >= N(0.35) else m_full[max(0, i0 - N(0.5)):min(len(m_full), i1 + N(0.5))]
    if len(probe) >= win * 2:
        cs = np.concatenate([[0.0], np.cumsum(probe * probe)])
        idx = np.arange(0, len(probe) - win + 1, max(1, win // 4))
        rms_w = np.sqrt(np.maximum((cs[idx + win] - cs[idx]) / win, 0.0))
        fl_lin = float(np.percentile(rms_w, 10))
    else:
        fl_lin = float(np.percentile(np.abs(probe), 15)) if len(probe) else 0.0
    floor_dbfs = float(20.0 * np.log10(max(fl_lin, 1e-7)))
    out_floor_dbfs = float(floor_dbfs + gain_db) if np.isfinite(gain_db) else np.inf

    reasons = []
    if raw_pk <= 1e-7:
        reasons.append('切片全零/无信号')
    elif max_gain_db is not None and gain_db > float(max_gain_db):
        reasons.append(f'归一化增益 {gain_db:+.1f} dB 超出洁净上限 {max_gain_db:+.1f} dB（raw_pk={raw_pk:.4f}）')
    has_floor_ctx = len(probe) >= win * 5
    if has_floor_ctx and np.isfinite(out_floor_dbfs) and max_out_floor_dbfs is not None and out_floor_dbfs > float(max_out_floor_dbfs):
        reasons.append(f'放大后底噪 {out_floor_dbfs:.1f} dBFS 超出上限 {max_out_floor_dbfs:.1f} dBFS')

    info = {
        'ok': len(reasons) == 0,
        'raw_pk': round(raw_pk, 6),
        'gain_db': round(gain_db, 2) if np.isfinite(gain_db) else None,
        'floor_dbfs': round(floor_dbfs, 2),
        'out_floor_dbfs': round(out_floor_dbfs, 2) if np.isfinite(out_floor_dbfs) else None,
        't0': round(i0 / SR, 4),
        't1': round(i1 / SR, 4),
        'reasons': reasons,
    }
    if reasons:
        if on_fail == 'raise':
            raise ValueError('load_slice 拒绝高噪低幅切片：' + '；'.join(reasons))
        return None, info

    seg = fade(seg * (float(target_peak) / raw_pk), min(0.002, len(seg) / SR * 0.1), min(0.008, len(seg) / SR * 0.2))
    return seg, info


def credits():
    return [f"{n}: {_M[n].get('title', '')} — {_M[n].get('author', '')} (https://freesound.org/s/{_M[n]['id']}/, CC0)"
            for n in sorted(USED)]
