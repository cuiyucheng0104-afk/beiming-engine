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

from .dsp import SR


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
