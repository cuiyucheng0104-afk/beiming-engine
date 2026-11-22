# -*- coding: utf-8 -*-
"""北冥引擎 · 拟音的 ERB 来源：同一个动作重复出现时，不再「同一段样本反复播 / 变调」，而是从来源声音学出 ERB 模型，
为每一个事件各渲一条全新的 take（起音一样脆，细节是新抽的，不含来源的任何一段原始波形）。

默认关闭：不调用本模块，拟音链路与以前逐比特相同；作品显式打开（film.json 的 audio.erb.enabled = true，或调用方传 override=True）才走这条路。

  take_seed(cue, event, take) → 31 位整数       种子只由（cue 标识、事件序号、take（候选）序号）决定，不依赖 Python 的 hash()，跨进程、跨平台一致
  fidelity(take, source) → {bw95_db, hf12_db, hf12_energy_db}   take 相对来源的 95% 能量带宽、>12 kHz 能量占比（dB）与 >12 kHz 绝对能量（dB）的偏差
  enabled(film=None, override=None) → bool      film 是 film.json 的内容或路径；override 优先；缺省 False
  ErbTakes(device='auto', exact=8, vary=1.0, candidates=4, tol_db=1.5, judge='foley_snap', cache_dir=None)
    .want(cue, sources, events)                 登记一个 cue：sources 是一到几段来源声音（(n,) 或 (n, 2)），events 个事件；事件 k 取第 k % len(sources) 段来源
    .render() → {cue: [(波形, 元信息), …]}      整片的全部任务合并成一次 erb.render_many（CUDA 只初始化一次）；没有 GPU 或显存不够时 engine/audio/erb 自动走 CPU
    .report                                      {jobs, candidates, cached, rendered, fallback, device（全部 take 同一设备时是它，否则 'mixed'）, devices（{设备: 条数}）, initMs（GPU 探测/首次编译）, cacheMs, analyzeMs, renderMs, gateMs}

保真闸：vary=1 的抖动（时长、尺寸、音色倾斜）本来就会让个别 take 的带宽或高频偏离来源，所以每个事件渲 candidates 个候选（候选序号 0.. 即种子的第三个参数，
全部在同一次批量里），按序取第一个同时满足「bw95、>12 kHz 占比、>12 kHz 能量相对来源的偏差都小于 tol_db，且过 sfx_judge（原型 judge）」的；
都不满足时取偏差最小的并标 gate='fallback'（report['fallback'] 计数，不静默）。这是挑选，不是拼接：入选的 take 仍是 ERB 整条再合成的结果。

缓存（与 scorecache 同一思路：键里写清输入，输入变了就不沿用）：每条 take 一对文件 <键>.npz（float32 波形与它的 sha256）+ <键>.json（输入明细）。
键 = 来源波形（含形状）、渲染参数、cue 与事件、erb 代码的 sha256、实际用的设备；GPU 与 CPU 的随机数不是同一组，所以设备算进键里。
读到坏文件（0 字节、截断、元信息不对）按未命中处理并重渲。device='auto' 时 GPU 键没命中会再查 CPU 键（上次显存不够退回过 CPU）；
device='gpu' 只认 GPU 键，没有 GPU 就抛 erb.gpu.GpuUnavailable。来源或输出有 NaN / Inf 时抛 ValueError，不渲染、不缓存、不交付。

接进拟音链路的方式：把 render() 的结果按事件顺序交给 editorial.schedule_action_series 或 ThreeStemWorkstation.add_foley_series（policy='erb'，见 foley.ActionVariationDeck），
一个事件用一条 take，不再变调、不再叠副层。
"""
import hashlib
import json
import os
import time
import uuid
import warnings

import numpy as np

from . import erb, scorecache

SCHEMA = 'beiming.erb-take/1'
HERE = os.path.dirname(os.path.abspath(__file__))
CODE = ('erb/core.py', 'erb/gpu.py', 'erb/erb_cuda.cu')


def take_seed(cue, event, take):
    """（cue 标识, 事件序号, 来源序号）→ 31 位种子。"""
    h = hashlib.sha256(f'beiming.erb-foley\0{cue}\0{int(event)}\0{int(take)}'.encode('utf-8')).digest()
    return int.from_bytes(h[:4], 'big') & 0x7FFFFFFF


def enabled(film=None, override=None):
    if override is not None:
        return bool(override)
    if isinstance(film, (str, os.PathLike)):
        with open(film, encoding='utf-8') as f:
            film = json.load(f)
    erb_cfg = ((film or {}).get('audio') or {}).get('erb')
    return bool(isinstance(erb_cfg, dict) and erb_cfg.get('enabled') is True)


def _wave_sha(x):
    a = np.ascontiguousarray(x, dtype='<f4')
    return hashlib.sha256(repr(a.shape).encode() + b'\0' + a.tobytes()).hexdigest()   # 带形状：同一串字节的单声道与立体声不撞键


def _spec(x):
    m = np.asarray(x, dtype=np.float64)
    m = m.mean(axis=1) if m.ndim == 2 else m
    p = np.abs(np.fft.rfft(m, norm='ortho')) ** 2   # ortho：补零不改变各频段的能量，长短不同的 take 才能直接比
    f = np.fft.rfftfreq(len(m), 1.0 / erb.core.SR)
    tot = float(p.sum()) + 1e-30
    bw95 = float(f[min(len(f) - 1, np.searchsorted(np.cumsum(p) / tot, 0.95))])
    hp = float(p[f >= 12000.0].sum())
    return bw95, hp / tot, hp


def fidelity(take, source):
    """take 相对来源的偏差（dB）：95% 能量带宽（20log）、>12 kHz 能量占比（10log）、>12 kHz 绝对能量（10log）。"""
    b, h, hp = _spec(take)
    sb, sh, shp = _spec(source)
    e = 1e-30
    return {'bw95_db': float(20 * np.log10((b + e) / (sb + e))), 'hf12_db': float(10 * np.log10((h + e) / (sh + e))),
            'hf12_energy_db': float(10 * np.log10((hp + e) / (shp + e)))}


def _worst(fid):
    return max(abs(v) for v in fid.values())


class ErbTakes:
    def __init__(self, device='auto', exact=8, vary=1.0, candidates=4, tol_db=1.5, judge='foley_snap', cache_dir=None):
        if device not in ('auto', 'gpu', 'cpu'):
            raise ValueError(f"device 只能是 'auto' / 'gpu' / 'cpu'，收到 {device!r}")
        if int(candidates) < 1:
            raise ValueError('candidates 至少 1')
        self.device, self.exact, self.vary, self.cache_dir = device, int(exact), float(vary), cache_dir
        self.candidates, self.tol_db, self.judge = int(candidates), float(tol_db), judge
        self._wants = {}
        self.report = {}

    def want(self, cue, sources, events):
        srcs = [np.asarray(s, dtype=np.float32) for s in (sources if isinstance(sources, (list, tuple)) else [sources])]
        if not srcs or events < 1:
            raise ValueError(f'ErbTakes.want({cue!r})：至少要一段来源和一个事件')
        for i, s in enumerate(srcs):
            if not (s.ndim == 1 or (s.ndim == 2 and s.shape[1] in (1, 2))) or len(s) < 16:
                raise ValueError(f'ErbTakes.want({cue!r})：第 {i} 段来源形状 {s.shape} 不对，要 (n,) 或 (n, 2)，n ≥ 16')
            if not np.isfinite(s).all():
                raise ValueError(f'ErbTakes.want({cue!r})：第 {i} 段来源有 NaN / Inf')
        if cue in self._wants:
            raise ValueError(f'ErbTakes.want：cue {cue!r} 登记过了')
        self._wants[cue] = (srcs, int(events))
        return self

    def _device_now(self):
        if self.device == 'cpu':
            return 'cpu'
        if erb.gpu.available():
            return 'gpu'
        if self.device == 'gpu':
            raise erb.gpu.GpuUnavailable('没有可用的 nvcc 或 GPU')
        return 'cpu'

    def _key(self, src_sha, cue, event, device):
        inputs = {'schema': SCHEMA, 'source': src_sha, 'cue': cue, 'event': event, 'vary': self.vary, 'exact': self.exact,
                  'candidates': self.candidates, 'tolDb': self.tol_db, 'judge': self.judge, 'device': device,
                  'code': scorecache.code_hashes(HERE, CODE + ('erb_foley.py', 'sfx_judge.py'))}
        return scorecache.digest(inputs), inputs

    def _load(self, key):
        if not self.cache_dir:
            return None
        base = os.path.join(self.cache_dir, key)
        try:
            with open(base + '.npz', 'rb') as fh, np.load(fh) as c:   # 自己开文件：np.load 半路抛错也不漏句柄
                w, sha, meta = c['wave'], str(c['sha256']), json.loads(str(c['meta']))
            ok = isinstance(meta, dict) and meta.get('gate') in ('pass', 'fallback') and _wave_sha(w) == sha and np.isfinite(w).all()
        except Exception:   # 0 字节、截断的 zip、字段缺失或类型不对：一律按未命中重渲
            return None
        return (w, meta) if ok else None

    def _save(self, key, inputs, wave, meta):
        if not self.cache_dir:
            return
        os.makedirs(self.cache_dir, exist_ok=True)
        base = os.path.join(self.cache_dir, key)
        w32 = np.ascontiguousarray(wave, dtype=np.float32)
        tmp = f'{base}.{uuid.uuid4().hex}.tmp'       # 每个写入者自己的临时名：同一个键并发写也不互相踩
        np.savez(tmp + '.npz', wave=w32, sha256=_wave_sha(w32), meta=json.dumps(meta, sort_keys=True))
        os.replace(tmp + '.npz', base + '.npz')
        with open(tmp + '.json', 'w', encoding='utf-8', newline='\n') as f:
            json.dump(inputs, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write('\n')
        os.replace(tmp + '.json', base + '.json')

    def _gate(self, wave, source):
        fid = fidelity(wave, source)
        from . import sfx_judge
        jg = sfx_judge.judge_wave(wave, sr=erb.core.SR, archetype=self.judge)
        ok = _worst(fid) < self.tol_db and jg['status'] == 'pass'
        return ok, fid, jg['status']

    def render(self):
        t00 = time.perf_counter()
        dev = self._device_now()          # 有 GPU 时第一次会现场编译内核（约 10 秒），单独计时
        t0 = time.perf_counter()
        out = {c: [None] * n for c, (_, n) in self._wants.items()}
        shas = {c: [_wave_sha(s) for s in srcs] for c, (srcs, _) in self._wants.items()}
        pending, hits, nfall = [], 0, 0             # pending: (cue, 事件序号, 来源序号)
        for cue, (srcs, n) in self._wants.items():
            for e in range(n):
                k = e % len(srcs)
                got = self._load(self._key(shas[cue][k], cue, e, dev)[0])
                if got is None and self.device == 'auto' and dev == 'gpu':   # 上次显存不够退回过 CPU：沿用那份
                    got = self._load(self._key(shas[cue][k], cue, e, 'cpu')[0])
                if got is None:
                    pending.append((cue, e, k))
                else:
                    out[cue][e] = (got[0], dict(got[1], cached=True))
                    hits += 1
                    nfall += got[1]['gate'] == 'fallback'
        t1 = time.perf_counter()
        used, ncand = dev, 0
        t2 = t3 = t4 = t1
        if pending:
            models, jobs, owner = {}, [], []
            for cue, e, k in pending:
                if (cue, k) not in models:
                    models[cue, k] = erb.core.analyze(self._wants[cue][0][k])
                for a in range(self.candidates):
                    jobs.append((models[cue, k], dict(seed=take_seed(cue, e, a), vary=self.vary, exact=self.exact)))
                    owner.append((cue, e, k, a))
            ncand = len(jobs)
            t2 = time.perf_counter()
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                ys = erb.render_many(jobs, device=self.device)      # 整片的全部候选只此一次
            for w in caught:                                       # 记下是否退回了 CPU，再原样发给调用方
                used = 'cpu' if '退回 CPU' in str(w.message) else used
                warnings.warn_explicit(w.message, w.category, w.filename, w.lineno)
            t3 = time.perf_counter()
            by = {}
            for (cue, e, k, a), y in zip(owner, ys):
                by.setdefault((cue, e), []).append((a, k, y))
            for (cue, e), cands in by.items():
                src = self._wants[cue][0][cands[0][1]]
                best = None                                         # (达标, 候选序号, 波形, 偏差, judge 状态)
                for a, k, y in cands:                               # 按候选序号取第一个达标的，都不达标取偏差最小的
                    if not np.isfinite(y).all():                    # 非有限的候选不参选
                        continue
                    ok, fid, js = self._gate(y, src)
                    if ok:
                        best = (True, a, y, fid, js)
                        break
                    if best is None or _worst(fid) < _worst(best[3]):
                        best = (False, a, y, fid, js)
                if best is None:
                    raise ValueError(f'ErbTakes：{cue} 事件 {e} 的 {len(cands)} 个候选全有 NaN / Inf，不保存也不交付')
                ok, a, y, fid, js = best
                k = cands[0][1]
                nfall += 0 if ok else 1
                meta = {'source': k, 'attempt': a, 'seed': take_seed(cue, e, a), 'gate': 'pass' if ok else 'fallback',
                        'fidelityDb': {kk: round(v, 3) for kk, v in fid.items()}, 'judge': js, 'device': used}
                key, inputs = self._key(shas[cue][k], cue, e, used)
                self._save(key, inputs, y, meta)
                out[cue][e] = (np.asarray(y, dtype=np.float32), dict(meta, cached=False))
            t4 = time.perf_counter()
        counts = {}                                         # 每条 take 实际来自哪台设备（命中的缓存可能是上次退回 CPU 时写的）
        for v in out.values():
            for _, m in v:
                counts[m['device']] = counts.get(m['device'], 0) + 1
        self.report = {'jobs': hits + len(pending), 'candidates': ncand, 'cached': hits, 'rendered': len(pending), 'fallback': nfall,
                       'device': next(iter(counts)) if len(counts) == 1 else ('mixed' if counts else used), 'devices': counts, 'initMs': round(1e3 * (t0 - t00), 1), 'cacheMs': round(1e3 * (t1 - t0), 1),
                       'analyzeMs': round(1e3 * (t2 - t1), 1), 'renderMs': round(1e3 * (t3 - t2), 1), 'gateMs': round(1e3 * (t4 - t3), 1)}
        return out
