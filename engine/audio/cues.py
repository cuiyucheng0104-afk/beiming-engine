# -*- coding: utf-8 -*-
"""北冥引擎 · 声画事件表（Python 侧）：读页面导出的 timeline.json / events.json，按节拍地址算时刻，
按事件类型分派拟音，登记"这一下音乐对哪个画面打点"，最后写混音与分轨。与 engine/core/tempo.js 是同一张表的两端。

  load(film_dir) → Film                     film.dir / film.timeline（没有 timeline.json 时为 None）/ film.events / film.dur
                                            film.tempo（有 timeline 时的 Tempo，否则 None）
  Tempo(secs, fps=24, digits=6)             与 tempo.js 同一公式；digits=None 不取整（沿用历史作品的写法时用）
    .at(sec, bar, beat=1, frac=0)           地址 → 秒（bar、beat 从 1 数）
    .beat(sec) / .bar(sec)                  一拍 / 一小节的秒数
    .section(t)                             t 所在段落（dict）
    .off_frame(t) / .off_grid(t, div=2)     到最近整帧 / 到 1/div 拍网格的距离（秒）
  Onsets()                                  音乐起音登记
    .mark(t, tag=None)                      记一个起音；带 tag 时记为该画面打点对应的音乐起音（同名只记第一次）
    .tags / .notes                          {tag: 秒} / 全部起音秒数
    .dump(path, notes=None)                 写 {'onsets': tags, 'notes': notes 或排序后的全部起音}（cuecheck 读它）
  dispatch(events, handlers, prepare=None)  逐条按 e['type'] 调 handlers[type](e)，顺序与 events 一致（随机数序列因此确定）；
                                            给了 prepare 时每条事件先算 ctx = prepare(e)（没有处理器的类型也算），再调 handlers[type](e, ctx)；
                                            返回 {没有处理器的类型: 条数}，调用方决定是报错还是忽略，不静默吞掉
  write(out_dir, mix, stems=None, sr=SR, subtype='PCM_24')   写 out_dir/mix.wav 与 out_dir/stems/<名>.wav，返回 mix.wav 路径

只做读表、换算、分派与落盘；声音本身由各作品的 mix.py 用 dsp / synth / sampler 合成。
"""
import json
import os
from collections import Counter

import numpy as np

from .dsp import SR


class Track:
    """画面逐帧连续物理遥测（window.KINEMATICS → kinematics.json）的 48 kHz 连续曲线插值器：
    将逐帧位置、速度、加速度、风压、景深或接触门限无阶梯重采样到音频采样率，直接驱动 foley / dsp.svf / doppler / space_place。"""

    def __init__(self, channels: dict, fps: float = 24.0, dur: float = None, sr: int = SR):
        self.channels = {k: np.asarray(v, dtype=float) for k, v in (channels or {}).items() if isinstance(v, (list, tuple, np.ndarray))}
        self.fps = float(fps)
        n_frames = max((len(v) for v in self.channels.values()), default=0)
        self.dur = float(dur) if dur is not None else (n_frames / self.fps if n_frames else 0.0)
        self.sr = int(sr)

    def arr(self, key: str, default: float = 0.0) -> np.ndarray:
        n_out = max(1, int(round(self.dur * self.sr)))
        seq = self.channels.get(key)
        if seq is None or len(seq) == 0:
            return np.full(n_out, float(default), dtype=float)
        if len(seq) == 1:
            return np.full(n_out, float(seq[0]), dtype=float)
        t_in = np.arange(len(seq), dtype=float) / self.fps
        t_out = np.arange(n_out, dtype=float) / self.sr
        return np.interp(t_out, t_in, seq)

    def speed_of(self, *pos_keys: str, scale: float = 1.0) -> np.ndarray:
        """从位置通道（如 'x', 'y'）求逐帧欧氏速率并平滑插值到音频采样率。"""
        n_out = max(1, int(round(self.dur * self.sr)))
        seqs = [self.channels[k] for k in pos_keys if k in self.channels and len(self.channels[k]) >= 2]
        if not seqs:
            return np.zeros(n_out, dtype=float)
        m = min(len(s) for s in seqs)
        sq = np.zeros(m, dtype=float)
        for s in seqs:
            d = np.gradient(s[:m]) * self.fps
            sq += d * d
        spd = np.sqrt(sq) * float(scale)
        t_in = np.arange(m, dtype=float) / self.fps
        t_out = np.arange(n_out, dtype=float) / self.sr
        return np.interp(t_out, t_in, spd)

    def pan(self, key: str = 'x', screen_w: float = 1920.0, spread: float = 0.85) -> np.ndarray:
        """把画面横向坐标（[0..1] 归一化或 [0..screen_w] 像素，或已是 [-1..1]）映射成 [-spread, +spread] 声像曲线。"""
        raw = self.arr(key, default=0.5)
        if np.max(np.abs(raw)) <= 1.05 and np.min(raw) < -0.05:
            norm = raw
        elif np.max(np.abs(raw)) <= 2.0:
            norm = raw * 2.0 - 1.0
        else:
            norm = (raw / max(screen_w, 1.0)) * 2.0 - 1.0
        return np.clip(norm * float(spread), -1.0, 1.0)

    def dist(self, key: str = 'depth', near: float = 0.8, far: float = 12.0) -> np.ndarray:
        """把景深通道映射成米制物理距离曲线（供 dsp.space_place / doppler 使用）。"""
        raw = self.arr(key, default=0.25)
        if np.max(raw) <= 1.05 and np.min(raw) >= -0.05:
            return near + np.clip(raw, 0.0, 1.0) * (far - near)
        return np.maximum(0.15, raw)

    def impulses(self, key: str, thresh: float = 0.5, min_gap_s: float = 0.08) -> list:
        """从接触量或角加速度序列提取离散脉冲事件 [(秒, 强度), ...]，自动抑制微抖动连发。"""
        seq = self.channels.get(key)
        if seq is None or len(seq) == 0:
            return []
        hits = []
        min_df = max(1, int(round(min_gap_s * self.fps)))
        last_f = -min_df - 1
        for i, v in enumerate(seq):
            prev_v = seq[i - 1] if i > 0 else 0.0
            next_v = seq[i + 1] if i + 1 < len(seq) else v
            if v >= thresh and v >= prev_v and v >= next_v and (i - last_f) >= min_df:
                if i == 0 or prev_v < thresh or v > prev_v:
                    hits.append((round(i / self.fps, 6), float(v)))
                    last_f = i
        return hits


class Kinematics:
    """多角色连续物理遥测容器：支持 kin['hero'].arr('speed') 或单轨直接 kin.track('default')。"""

    def __init__(self, raw: dict, dur: float = None, sr: int = SR):
        self.fps = float((raw or {}).get('fps') or 24.0)
        self.dur = float(dur if dur is not None else ((raw or {}).get('dur') or 0.0))
        self.sr = int(sr)
        tracks_raw = (raw or {}).get('tracks')
        if isinstance(tracks_raw, dict):
            self.tracks = {k: Track(v, fps=self.fps, dur=self.dur or None, sr=self.sr)
                           for k, v in tracks_raw.items() if isinstance(v, dict)}
        else:
            ch = {k: v for k, v in (raw or {}).items() if k not in ('fps', 'dur') and isinstance(v, (list, tuple, np.ndarray))}
            self.tracks = {'default': Track(ch, fps=self.fps, dur=self.dur or None, sr=self.sr)} if ch else {}

    def __getitem__(self, name: str) -> Track:
        return self.tracks[name]

    def get(self, name: str = 'default') -> Track:
        return self.tracks.get(name) or Track({}, fps=self.fps, dur=self.dur, sr=self.sr)


def load_kinematics(source, dur: float = None, sr: int = SR) -> Kinematics:
    if isinstance(source, str):
        p = os.path.join(source, 'kinematics.json') if os.path.isdir(source) else source
        with open(p, encoding='utf-8') as f:
            raw = json.load(f)
    else:
        raw = dict(source or {})
    return Kinematics(raw, dur=dur, sr=sr)


class Tempo:
    def __init__(self, secs, fps=24, digits=6):
        if not secs:
            raise ValueError('Tempo：至少要一个段落')
        self.fps, self.digits = fps, digits
        self.secs = []
        for i, s in enumerate(secs):
            t1 = s.get('t1', secs[i + 1]['t0'] if i + 1 < len(secs) else float('inf'))
            self.secs.append(dict(s, t1=t1))
        self.by_id = {s['id']: s for s in self.secs}

    def _get(self, sec):
        if sec not in self.by_id:
            raise KeyError(f'节拍表里没有段落 {sec}')
        return self.by_id[sec]

    def at(self, sec, bar, beat=1, frac=0.0):
        s = self._get(sec)
        t = s['t0'] + ((bar - 1) * s['meter'] + (beat - 1) + frac) * 60.0 / s['bpm']
        return t if self.digits is None else round(t, self.digits)

    def beat(self, sec):
        return 60.0 / self._get(sec)['bpm']

    def bar(self, sec):
        s = self._get(sec)
        return s['meter'] * 60.0 / s['bpm']

    def section(self, t):
        for s in self.secs:
            if s['t0'] - 1e-9 <= t < s['t1'] - 1e-9:
                return s
        return self.secs[0] if t < self.secs[0]['t0'] else self.secs[-1]

    def off_frame(self, t):
        return abs(t * self.fps - round(t * self.fps)) / self.fps

    def off_grid(self, t, div=2):
        s = self.section(t)
        step = 60 / s['bpm'] / div
        k = round((t - s['t0']) / step)
        return abs(t - (s['t0'] + k * step))


class Film:
    def __init__(self, film_dir):
        self.dir = os.path.abspath(film_dir)
        tl = os.path.join(self.dir, 'timeline.json')
        with open(os.path.join(self.dir, 'events.json'), encoding='utf-8') as f:
            ej = json.load(f)
        self.events, self.dur = ej['ev'], ej['dur']
        self.timeline = None
        self.tempo = None
        if os.path.exists(tl):
            with open(tl, encoding='utf-8') as f:
                self.timeline = json.load(f)
            if self.timeline.get('secs'):
                self.tempo = Tempo(self.timeline['secs'], self.timeline.get('fps', 24))
        kp = os.path.join(self.dir, 'kinematics.json')
        self.kinematics = load_kinematics(kp, dur=self.dur) if os.path.exists(kp) else None


def load(film_dir):
    return Film(film_dir)


class Onsets:
    def __init__(self):
        self.tags = {}
        self.notes = []

    def mark(self, t, tag=None):
        self.notes.append(t)
        if tag:
            self.tags.setdefault(tag, round(t, 6))
        return t

    def dump(self, path, notes=None):
        if notes is None:
            notes = sorted(round(t, 6) for t in self.notes)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'w') as f:
            json.dump({'onsets': self.tags, 'notes': notes}, f, indent=0)


def dispatch(events, handlers, prepare=None):
    missing = Counter()
    for e in events:
        ctx = prepare(e) if prepare else None   # 每条事件都先调（含没有处理器的类型），逐事件抽随机数时序列不乱
        h = handlers.get(e['type'])
        if h is None:
            missing[e['type']] += 1
        elif prepare:
            h(e, ctx)
        else:
            h(e)
    return dict(missing)


def write(out_dir, mix, stems=None, sr=SR, subtype='PCM_24'):
    import soundfile as sf
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, 'mix.wav')
    sf.write(path, mix, sr, subtype=subtype)
    if stems:
        os.makedirs(os.path.join(out_dir, 'stems'), exist_ok=True)
        for name, x in stems.items():
            sf.write(os.path.join(out_dir, 'stems', f'{name}.wav'), x, sr, subtype=subtype)
    return path
