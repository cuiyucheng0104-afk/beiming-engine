# -*- coding: utf-8 -*-
"""北冥引擎 · 声画拍点核对（三条路线通用）：画面打点离整帧、离节拍网格、离时间线、离音乐起音各有多远；声音表时刻离画面结果帧
有多远（按不对称的同步容差）；可选查静默段、实测混音里的起音。超差以退出码 4 挡在出片之前。

用法（在仓库根目录）：
  python -m engine.audio.cuecheck <作品目录> [--grid 2] [--tol-ms 0.5] [--keys 类型或 id,…] [--silence 段,段] [--quiet-db 15]
         [--film <film.json>] [--events <events.json>] [--timeline <timeline.json>] [--onsets <score_onsets.json>] [--mix <mix.wav>]
         [--measure] [--early-ms 10.4] [--late-frames 1] [--report <cuecheck.json>] [--json]

事件表（与路线无关，找到的都核对）：
  · <作品>/events.json（页面 window.EV 导出，C 路线）：带 cue（或历史写法的 hit）的事件是画面打点；snap: false 的不对网格（刻意离拍）
  · film.json v2 的 events[]：cue: true 是画面打点（frame 是整数帧，只写了 t 秒时按 round(t × fps) 取帧；有 beat 时核对
    frame = floor(拍点帧)）；audio 引用一个声音，声音时刻依次从两处找：声音表（film.json audio.cues 指向的文件，A 路线《北冥》是
    audio/cues.json，取 cue 的 t）→ 声音脚本登记的起音（out/score_onsets.json 的 onsets，B、C 路线的声音脚本用
    engine.audio.cues.Onsets.mark(t, 标签) 登记，标签写 audio 的值或事件 id）。核对"声音时刻 − 画面结果帧"落在同步容差里：
    声音晚 0 – late-frames 帧（默认 1 帧）、早不超过 early-ms（默认 0.25 帧 ≈ 10.4 ms @24 fps）；sync: "lip"（或 visual: "lip"）
    允许晚 2 帧，sync: "soft" 只告警，sync: false / "none" 不查（routes/directing/craft/animation.md §5.7，与 tools/qa 的 sync 同口径）。
    两处都查不到这个声音时记一条告警（不静默跳过）：声明了声音却没有登记，只能等成片由 tools/qa sync 实测
节拍网格：timeline.json 的 secs（与 engine/core/tempo.js 同一张表）；film.json v2 的 timeline.sections（start 为帧号）；
  或历史写法的全局 BPM（另有 METER / E8 / E16 时照用）。--grid 是一拍细分：2 八分、3 三连、4 十六分、6、8……
关键事件集合：--keys、film.json cuecheck.keys、timeline.json 的 keys / KEYS / KEY，或事件自己 key: true；写法是事件类型或 cue / id。
  关键事件必须有同一时刻（≤ tol）的音乐起音（score_onsets.json 的 notes 里任意一个，不要求打标签），否则判不通过。
--measure：在混音（有分轨时用该声音所在总线的分轨）里实测瞬态类声音事件的起音（2 ms 包络、抬升 ≥ 9 dB、峰前 20% 处），
  按同步容差再看一遍；实测只给告警，成片的声画同步以 tools/qa 对最终文件的 sync 检查为准。

退出码（附录 C1）：0 全部通过（会打印 CUECHECK OK）；4 有超差（CUECHECK FAIL）；2 用法错误；3 缺事件表 / 时间表 / 混音；1 运行失败。
报告：--report 写一份 JSON（附录 C8 的 checks 加逐事件明细 events、silences，结构见 routes/directing/PRODUCTION-SPEC.md §9）。

接口：check(film_dir, tol_ms=0.5, grid=2, silences=(), quiet_db=15.0, out=print, **选项) → bool（旧调用照用）
      run_check(...) → 报告 dict
"""
import json
import os
import sys
from fractions import Fraction

import numpy as np

from ._cli import ArgumentParser, CliError, rel as _rel, run as run_cli, sha256_file
from .cues import Tempo

DEF_TOL_MS = 0.5


def _ci(d, *names):
    """大小写不敏感地取字段（历史时间表的键名有全大写、全小写、混用三种写法）"""
    low = {k.lower(): v for k, v in d.items()}
    for n in names:
        if n.lower() in low:
            return low[n.lower()]
    return None


def _load_json(p, what):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except ValueError as e:
        raise CliError('contract.json', f'{what} 不是合法 JSON：{p}（{e}）', hint='重新导出（node engine/render/events.mjs <作品>）') from None


def tempo_of(tl, film=None):
    """时间表 → (Tempo 或 None, 说明)。支持 secs / SECS、全局 BPM，以及 film.json v2 的 timeline.sections（帧号）"""
    if tl:
        fps = _ci(tl, 'fps') or (film or {}).get('fps') or 24
        secs = _ci(tl, 'secs')
        if isinstance(secs, list) and secs and all(isinstance(s, dict) and 't0' in s and 'bpm' in s for s in secs):
            return Tempo([dict(s, meter=s.get('meter', 4)) for s in secs], fps, digits=None), 'timeline.secs'
        bpm = _ci(tl, 'bpm')
        if isinstance(bpm, (int, float)) and bpm > 0:
            meter = _ci(tl, 'meter', 'bar_beats') or 4
            return Tempo([{'id': 'A', 't0': 0.0, 'bpm': float(bpm), 'meter': meter}], fps, digits=None), 'timeline.BPM'
    t2 = (film or {}).get('timeline') or {}
    secs = t2.get('sections') if isinstance(t2, dict) else None
    if film and isinstance(secs, list) and secs:
        fps = film['fps']
        ss = [{'id': s.get('id', f'S{i + 1}'), 't0': s['start'] / fps, 'bpm': s['bpm'], 'meter': s.get('meter', 4)} for i, s in enumerate(secs)]
        return Tempo(ss, fps, digits=None), 'film.json timeline.sections'
    return None, None


def _address(tempo, t, grid):
    s = tempo.section(t)
    b = (t - s['t0']) / (60 / s['bpm'])
    bar, beat = int(b // s['meter']) + 1, b % s['meter']
    whole = int(beat + 1e-9)
    frac = Fraction(beat - whole).limit_denominator(max(8, int(grid) * 4))
    return f"{s['id']}{bar}.{whole + 1}" + (f'+{frac.numerator}/{frac.denominator}' if frac else '')


def measure_onset(x, sr, t, early=0.15, late=0.25, min_rise_db=9.0):
    """t 附近（前 early、后 late 秒）找最像"这一下"的起音：一阶预加重与全频带两路 2 ms RMS 包络（0.5 ms 步长），
    候选是比此前 5–20 ms 底噪抬高 ≥ min_rise_db 的局部峰，起音取峰前越过「底噪 + 20%×(峰 − 底噪)」的位置。
    方法与 tools/qa/lib/audio.mjs 的 findOnset 相同（同一仓库的声画同步检查，口径一致）。返回秒或 None"""
    best = None
    for emph in (0.0, 0.97):
        r = _onset_in(x, sr, t, early, late, min_rise_db, emph)
        if r and (best is None or r[1] > best[1] + 3):
            best = r
    return None if best is None else round(best[0], 5)


def _onset_in(x, sr, t, early, late, min_rise_db, emph):
    win, hop = max(8, int(round(sr * 0.002))), max(1, int(round(sr * 0.0005)))
    a, b = max(1, int((t - early - 0.03) * sr)), min(len(x), int(np.ceil((t + late + 0.03) * sr)))
    if b - a <= win + 8:
        return None
    seg = x[a:b] - emph * x[a - 1:b - 1]
    c = np.concatenate([[0.0], np.cumsum(seg * seg)])
    m = (len(seg) - win) // hop
    starts = np.arange(m) * hop
    env = np.sqrt((c[starts + win] - c[starts]) / win)
    t0 = (a + win / 2) / sr
    hs = hop / sr
    k0, k1 = max(1, int(round((t - early - t0) / hs))), min(len(env) - 2, int(round((t + late - t0) / hs)))
    fl0, fl1 = int(round(0.005 / hs)), int(round(0.02 / hs))
    cands = []
    for k in range(k0, k1 + 1):
        if not (env[k] >= env[k - 1] and env[k] >= env[k + 1]):
            continue
        j = min(len(env), k + int(round(0.01 / hs)) + 1)
        if env[k:j].max() > env[k]:
            continue
        lo, hi = max(0, k - fl1), max(0, k - fl0)
        fl = float(np.median(env[lo:hi])) if hi > lo else float(env[0])
        rise = 20 * np.log10((env[k] + 1e-9) / (fl + 1e-9))
        if rise >= min_rise_db:
            cands.append((k, rise, fl, float(env[k])))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[1])
    best = cands[0]
    for cnd in cands[1:]:
        if cnd[1] >= 0.7 * best[1] and abs(t0 + cnd[0] * hs - t) < abs(t0 + best[0] * hs - t):
            best = cnd
    k, rise, fl, pk = best
    thr = fl + 0.2 * (pk - fl)
    while k > 0 and env[k - 1] >= thr:
        k -= 1
    kk = k - 1 + (thr - env[k - 1]) / max(1e-12, env[k] - env[k - 1]) if k > 0 else 0
    return t0 + kk * hs + 0.46 * win / sr, rise


def _keyset(cli_keys, film, tl):
    keys = set()
    for src in (cli_keys, ((film or {}).get('cuecheck') or {}).get('keys'), _ci(tl or {}, 'keys')):
        if isinstance(src, str):
            keys |= {s.strip() for s in src.split(',') if s.strip()}
        elif isinstance(src, (list, tuple, set)):
            keys |= {str(s) for s in src}
    return keys


def run_check(film_dir, *, tol_ms=DEF_TOL_MS, grid=2, silences=(), quiet_db=15.0, keys=None, film_json=None, events=None,
              timeline=None, onsets=None, mix=None, measure=False, early_ms=None, late_frames=1.0, out=print):
    from . import filmspec as F
    here = os.path.abspath(film_dir)
    film = None
    fj = film_json or os.path.join(here, 'film.json')
    if os.path.exists(fj):
        try:
            film = F.load(fj)
        except F.FilmSpecError as e:
            raise CliError(e.code, e.message, hint=e.hint) from None
    ev_path = events or os.path.join(here, 'events.json')
    tl_path = timeline or os.path.join(here, 'timeline.json')
    so_path = onsets or os.path.join(here, 'out', 'score_onsets.json')
    EVJ = _load_json(ev_path, 'events.json')
    TL = _load_json(tl_path, 'timeline.json')
    SO = _load_json(so_path, 'score_onsets.json') or {'onsets': {}, 'notes': []}
    if isinstance(SO, list):          # 历史写法：out/score.json 是 [[秒, …], …] 的起音列表（没有标签）
        SO = {'onsets': {}, 'notes': [x[0] if isinstance(x, (list, tuple)) else x for x in SO]}
    if EVJ is None and not (film and film['events']):
        raise CliError('env.events-missing', f'没有事件表：{ev_path} 不存在，film.json 里也没有 events',
                       hint='C 路线先导出：node engine/render/events.mjs <作品目录>；A / B 路线在 film.json 的 events 里写事件')
    fps = (_ci(TL or {}, 'fps') or (film or {}).get('fps') or 24)
    tempo, tempo_src = tempo_of(TL, film)
    keyset = _keyset(keys, film, TL)
    tl_t = (_ci(TL or {}, 't') or {}) if TL else {}
    notes = sorted(float(n) for n in SO.get('notes', []))
    tags = SO.get('onsets', {})
    fd = 1.0 / fps
    early = (early_ms if early_ms is not None else 0.25 * fd * 1000) * 1e-3

    rows, sync_rows = [], []
    # —— 1. 画面打点（events.json） ——
    for e in (EVJ or {}).get('ev', []):
        c = e.get('cue') or e.get('hit')
        snap = e.get('snap')
        if not c and not snap:
            continue
        name = str(c) if c else f"{e.get('type')}@{e['t']}"
        t = float(e.get('peak', e['t'])) if 'hit' in e and not e.get('cue') else float(e['t'])
        is_key = bool(e.get('key')) or name in keyset or str(e.get('type')) in keyset
        rows.append(_hit(name, t, fps, tempo, grid, tl_t.get(c) if c else None, tags.get(c) if c else None, notes, is_key,
                         grid_exempt=(snap is not None and not snap) or e.get('offGrid') is True, source='events.json', etype=e.get('type')))
    # —— 2. film.json v2 的事件：画面打点 + 声音表同步 ——
    cue_tab = {}
    if film and (film.get('audio') or {}).get('cues'):
        cj = _load_json(F.resolve(film, film['audio']['cues']), '声音表')
        if cj is None:
            raise CliError('env.cues-missing', f'film.json 的 audio.cues 指向的声音表不存在：{film["audio"]["cues"]}')
        cue_tab = {c['id']: c for c in cj.get('cues', [])}
    seen = {r['id'] for r in rows}

    def sound_time(ref, eid):
        """声音时刻（秒）与出处：声音表 → 声音脚本登记的起音（先按 audio 的值，再按事件 id）"""
        cue = cue_tab.get(ref)
        if cue is not None and cue.get('t') is not None:
            return float(cue['t']), 'cues', cue
        for k in (ref, eid):
            if k is not None and tags.get(k) is not None:
                return float(tags[k]), 'score_onsets', {}
        return None, None, None
    for e in (film or {}).get('events', []) if film and film['version'] == 2 else []:
        eid, frame = e.get('id'), e.get('frame')
        if not isinstance(frame, int) and isinstance(e.get('t'), (int, float)) and not isinstance(e.get('t'), bool):
            frame = int(round(float(e['t']) * fps))
        if not isinstance(frame, int) or isinstance(frame, bool):
            continue
        is_key = bool(e.get('key')) or eid in keyset
        if e.get('cue') is True and eid not in seen:
            r = _hit(eid, frame / fps, fps, tempo, grid, None, tags.get(eid), notes, is_key, source='film.json', etype=e.get('domain'))
            if e.get('beat') is not None and tempo is not None:
                bt = float(e['beat'])
                s0 = tempo.secs[0]
                want = int(np.floor((s0['t0'] + bt * 60 / s0['bpm']) * fps + 1e-6)) if len(tempo.secs) == 1 else None
                if want is not None and want != frame:
                    r['problems'].append(f'beat {bt} 在第 {want} 帧，事件写第 {frame} 帧')
                    r['status'] = 'fail'
            rows.append(r)
        sync = e.get('sync', True)
        ref = e.get('audio')
        if not ref or sync in (False, 'none'):
            continue
        ref = str(ref)
        if e.get('visual') == 'lip' and sync is True:
            sync = 'lip'
        t_snd, src, _ = sound_time(ref, eid)
        t_vis = frame / fps
        if t_snd is None:
            where = '、'.join(w for w, ok in (('声音表 ' + str((film.get('audio') or {}).get('cues')), bool(cue_tab)),
                                              ('out/score_onsets.json 的 onsets', bool(tags))) if ok)
            if cue_tab and not tags:
                sync_rows.append({'id': eid, 'audio': ref, 'frame': frame, 'status': 'fail' if sync != 'soft' else 'warn', 'deltaMs': None,
                                  'kind': 'declared', 'problems': [f'声音表里没有 {ref}']})
            else:
                sync_rows.append({'id': eid, 'audio': ref, 'frame': frame, 'status': 'warn', 'deltaMs': None, 'kind': 'declared',
                                  'problems': [f'{where or "没有声音表，也没有 score_onsets.json"}里查不到 {ref} 的时刻：声明值核对不了'
                                               '（声音脚本用 engine.audio.cues.Onsets.mark(t, 标签) 登记；成片另由 tools/qa sync 实测）']})
            continue
        late = (2.0 if sync == 'lip' else late_frames) * fd
        d = t_snd - t_vis
        st = 'pass' if -early - 1e-9 <= d <= late + 1e-9 else ('warn' if sync == 'soft' else 'fail')
        sync_rows.append({'id': eid, 'audio': ref, 'frame': frame, 'soundT': round(t_snd, 6), 'soundFrom': src, 'deltaMs': round(d * 1e3, 2),
                          'deltaFrames': round(d * fps, 3), 'status': st, 'kind': 'declared', 'sync': sync,
                          'problems': [] if st == 'pass' else [f'声音比画面{"早" if d < 0 else "晚"} {abs(d) * 1e3:.1f} ms（容差：早 ≤ {early * 1e3:.1f} ms、晚 ≤ {late * 1e3:.1f} ms）']})
    _judge(rows, tol_ms)
    # —— 3. 实测起音（可选） ——
    mix_path = mix or os.path.join(here, 'out', 'mix.wav')
    if film and film['dir'] != here and not mix and not os.path.exists(mix_path):
        mix_path = os.path.join(film['dir'], 'out', 'mix.wav')
    if measure:
        if not os.path.exists(mix_path):
            raise CliError('env.mix-missing', f'--measure 要混音：{mix_path} 不存在', hint='先出声音，或用 --mix 指定')
        import soundfile as sf
        x, sr = sf.read(mix_path, dtype='float64', always_2d=True)
        mono = x.mean(axis=1)
        stem_dirs = [os.path.join(os.path.dirname(mix_path), 'stems')]
        if film and (film.get('audio') or {}).get('cues'):
            stem_dirs.append(os.path.join(os.path.dirname(F.resolve(film, film['audio']['cues'])), 'stems'))
        stems = {}

        def signal_for(bus):
            """优先用这条声音所在总线的分轨（密的混音里轻的提示音测不准），没有就用混音"""
            if bus and bus not in stems:
                hit = next((os.path.join(d, f'{bus}.wav') for d in stem_dirs if os.path.exists(os.path.join(d, f'{bus}.wav'))), None)
                stems[bus] = sf.read(hit, dtype='float64', always_2d=True)[0].mean(axis=1) if hit else None
            return (stems.get(bus) if bus else None), (f'stems/{bus}.wav' if bus and stems.get(bus) is not None else 'mix')
        for r in [s for s in sync_rows if s.get('soundT') is not None]:
            cue = cue_tab.get(r['audio'], {})
            bus = cue.get('bus') or cue.get('layer')
            if bus in ('music', 'amb', 'master', 'mix'):
                continue                      # 慢起的配乐与环境声没有可测的瞬态：只核对声明值
            sig, src = signal_for(bus)
            o = measure_onset(sig if sig is not None else mono, sr, r['soundT'], early=0.04, late=0.08)
            late = (2.0 if r.get('sync') == 'lip' else late_frames) * fd
            if o is None:
                sync_rows.append({'id': r['id'], 'audio': r['audio'], 'frame': r['frame'], 'kind': 'measured', 'status': 'warn', 'signal': src,
                                  'deltaMs': None, 'problems': [f'{src} 里 {r["soundT"]:.3f} s 附近没有检出起音（实测只作参考）']})
                continue
            d = o - r['frame'] / fps
            st = 'pass' if -early - 1e-9 <= d <= late + 1e-9 else 'warn'
            sync_rows.append({'id': r['id'], 'audio': r['audio'], 'frame': r['frame'], 'kind': 'measured', 'onsetT': o, 'signal': src,
                              'deltaMs': round(d * 1e3, 2), 'status': st,
                              'problems': [] if st == 'pass' else [f'实测起音比画面{"早" if d < 0 else "晚"} {abs(d) * 1e3:.1f} ms（{src}；实测只作参考）']})
    # —— 4. 静默段 ——
    sil_rows = []
    if silences:
        if tempo is None:
            raise CliError('usage.silence-without-tempo', '--silence 要用时间表里的段落 id，但没有节拍表（timeline.json 的 secs）')
        if not os.path.exists(mix_path):
            raise CliError('env.mix-missing', f'查静默段要混音：{mix_path} 不存在', hint='先出声音，或用 --mix 指定')
        import soundfile as sf
        x, sr = sf.read(mix_path)
        mono = x.mean(1) if x.ndim == 2 else x

        def rms_db(a, b):
            y = mono[int(a * sr):int(b * sr)]
            return 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12) if len(y) else -240.0
        dur = _ci(TL or {}, 'dur') or len(mono) / sr
        full = rms_db(0, dur)
        for sid in silences:
            if sid not in tempo.by_id:
                raise CliError('usage.silence-unknown', f'节拍表里没有段落 {sid}', hint=f'可用：{"、".join(tempo.by_id)}')
            S = tempo.by_id[sid]
            inside = [n for n in notes if S['t0'] <= n < S['t1'] - 1e-6]
            sil = rms_db(S['t0'] + .3, S['t1'] - .02)
            after = rms_db(S['t1'], S['t1'] + .5)
            ok = not inside and full - sil >= quiet_db
            sil_rows.append({'id': sid, 't0': S['t0'], 't1': S['t1'], 'noteOnsets': len(inside), 'rmsDb': round(sil, 1), 'filmRmsDb': round(full, 1),
                             'afterDb': round(after, 1), 'status': 'pass' if ok else 'fail'})

    # —— 打印（与旧版同一张表，多了地址的分数写法与状态列） ——
    out(f"{'cue':12} {'t (s)':>8} {'frame':>5}  {'bar.beat':11} {'frame ms':>8} {'grid ms':>8} {'tl ms':>6} {'music ms':>9}  ")
    for r in rows:
        md = r.get('musicMs')
        out(f"{r['id'][:12]:12} {r['t']:8.4f} {r['frame']:5d}  {r.get('address') or '-':11} {r['offFrameMs']:8.3f} "
            f"{('%8.3f' % r['offGridMs']) if r['offGridMs'] is not None else '       -'} {r['timelineMs']:6.3f} "
            f"{'   (fx)' if md is None else f'{md:9.3f}'}  {'' if r['status'] == 'pass' else '✗ ' + '；'.join(r['problems'])}")
    untagged = [r['id'] for r in rows if r.get('musicMs') is None]
    worst = max([0.0] + [max(v for v in (r['offFrameMs'], r['offGridMs'] or 0.0, r['timelineMs'], r.get('musicMs') or 0.0)) for r in rows])
    if rows:
        out(f"\n{len(rows)} visual hits · {len(rows) - len(untagged)} with a music onset · max deviation {worst:.3f} ms"
            + (f' · grid 1/{grid:g} beat ({tempo_src})' if tempo else ' · no tempo grid'))
        if untagged:
            out('carried by foley only (no music note): ' + ', '.join(untagged))
        if keyset:
            out('key events (must sit on a music onset): ' + ', '.join(r['id'] for r in rows if r['key']) or '(none matched)')
    for s in sync_rows:
        out(f"sync {s['kind']:8} {s['id']:16} → {s['audio']:12} frame {s['frame']:4d}  Δ {('%+.1f ms' % s['deltaMs']) if s['deltaMs'] is not None else 'n/a':>10}  "
            f"{'' if s['status'] == 'pass' else ('! ' if s['status'] == 'warn' else '✗ ') + '；'.join(s['problems'])}")
    for s in sil_rows:
        out(f"silence {s['t0']}–{s['t1']} s: {s['noteOnsets']} note onsets · RMS {s['rmsDb']:.1f} dBFS (film {s['filmRmsDb']:.1f}, "
            f"first 0.5 s after {s['afterDb']:.1f}) → {s['afterDb'] - s['rmsDb']:.1f} dB jump")
    if not rows and not sync_rows:
        out('没有可核对的事件：events.json 里没有带 cue 的打点，film.json 的事件也没有 cue: true 或 audio')
    ok = all(r['status'] != 'fail' for r in rows + sync_rows + sil_rows)
    out('CUECHECK ' + ('OK' if ok else 'FAIL'))
    rep = _report(film, ev_path if EVJ is not None else (film or {}).get('file'), rows, sync_rows, sil_rows, ok, tol_ms, grid, tempo_src,
                  early, late_frames * fd, keyset)
    rep['_rows'] = rows
    return rep


def _hit(name, t, fps, tempo, grid, tl_t, tag_t, notes, is_key, grid_exempt=False, source='', etype=None):
    """一个画面打点的各项偏差（秒 → 毫秒）；判定在 _judge"""
    f = abs(t * fps - round(t * fps)) / fps
    g = tempo.off_grid(t, grid) if tempo is not None and not grid_exempt else None
    tl = abs(t - float(tl_t)) if tl_t is not None else 0.0
    m = abs(t - float(tag_t)) if tag_t is not None else None
    near = None
    if notes:
        i = int(np.searchsorted(notes, t))
        near = min((abs(notes[j] - t) for j in (i - 1, i) if 0 <= j < len(notes)), default=None)
    if is_key and m is None and near is not None:
        m = near
    r = {'id': name, 'type': etype, 'source': source, 't': round(t, 6), 'frame': int(round(t * fps)), 'key': is_key,
         'address': _address(tempo, t, grid) if tempo is not None else None, 'offFrameMs': f * 1e3,
         'offGridMs': None if g is None else g * 1e3, 'timelineMs': tl * 1e3, 'musicMs': None if m is None else m * 1e3,
         'gridExempt': grid_exempt, 'problems': [], 'status': 'pass'}
    return r


def _judge(rows, tol_ms):
    for r in rows:
        p = r['problems']
        if r['offFrameMs'] > tol_ms:
            p.append(f'离整帧 {r["offFrameMs"]:.2f} ms')
        if r['offGridMs'] is not None and r['offGridMs'] > tol_ms:
            p.append(f'离网格 {r["offGridMs"]:.2f} ms')
        if r['timelineMs'] > tol_ms:
            p.append(f'离时间线 {r["timelineMs"]:.2f} ms')
        if r['musicMs'] is not None and r['musicMs'] > tol_ms:
            p.append(f'离音乐起音 {r["musicMs"]:.2f} ms')
        if r['key'] and r['musicMs'] is None:
            p.append('关键事件没有同拍的音乐起音')
        if p:
            r['status'] = 'fail'


def _report(film, input_path, rows, sync_rows, sil_rows, ok, tol_ms, grid, tempo_src, early, late, keyset):
    def chk(id_, title, items, value, expected):
        bad = [i for i in items if i['status'] == 'fail']
        warn = [i for i in items if i['status'] == 'warn']
        return {'id': id_, 'group': 'sync', 'title': title, 'severity': 'hard', 'status': 'fail' if bad else ('warn' if warn else 'pass'),
                'value': value, 'expected': expected, 'evidence': {'items': items},
                'message': '；'.join(f"{i['id']}：{'；'.join(i.get('problems', []))}" for i in (bad + warn)[:5])}
    checks = []
    if rows:
        checks.append(chk('cuecheck.hits', '画面打点：整帧、网格、时间线、音乐起音', rows,
                          f'{len(rows)} 个打点，最大偏差 {max(max(r["offFrameMs"], r["offGridMs"] or 0, r["timelineMs"], r["musicMs"] or 0) for r in rows):.3f} ms',
                          f'≤ {tol_ms} ms（网格 1/{grid:g} 拍{"，" + tempo_src if tempo_src else "，没有节拍表"}）'))
    if keyset:
        ks = [r for r in rows if r['key']]
        checks.append(chk('cuecheck.keys', '关键事件都有同拍的音乐起音', ks, f'{len(ks)} 个关键事件', f'每个都有 ≤ {tol_ms} ms 的音乐起音'))
    if sync_rows:
        checks.append(chk('cuecheck.sync', '声音表时刻对画面结果帧（同步容差）', sync_rows, f'{len(sync_rows)} 条',
                          f'声音晚 0–{late * 1e3:.1f} ms、早不超过 {early * 1e3:.1f} ms'))
    if sil_rows:
        checks.append(chk('cuecheck.silence', '静默段：没有音符起音、确实安静', sil_rows, f'{len(sil_rows)} 段', '段内 0 个起音、RMS 比全片低够'))
    if not checks:
        checks.append({'id': 'cuecheck.hits', 'group': 'sync', 'title': '画面打点', 'severity': 'soft', 'status': 'warn', 'value': '没有可核对的事件',
                       'expected': '至少一个画面打点或声音同步事件', 'evidence': {'notRun': True}, 'message': '未执行：没有可核对的事件'})
    sha = sha256_file(input_path) if input_path and os.path.exists(input_path) else None
    ev = [{'id': r['id'], 'plannedFrame': r['frame'], 'pictureFrame': r['frame'], 't': r['t'], 'address': r['address'],
           'offFrameMs': round(r['offFrameMs'], 4), 'offGridMs': None if r['offGridMs'] is None else round(r['offGridMs'], 4),
           'musicOnsetMs': None if r['musicMs'] is None else round(r['musicMs'], 4), 'key': r['key'], 'status': r['status']} for r in rows]
    devs = [d for r in rows for d in (r['offFrameMs'], r['offGridMs'] or 0, r['timelineMs'], r['musicMs'] or 0)]
    return {'schemaVersion': 1, 'tool': {'name': 'beiming-cuecheck', 'version': '2.1.0'},
            'film': {'id': film['id'], 'title': film['title'], 'route': film['route'], 'file': _rel(film['file']), 'frameCount': film['frameCount']} if film else None,
            'input': {'path': _rel(input_path), 'sha256': sha} if sha else None,
            'profile': {'id': (film or {}).get('profile') or 'n/a', 'source': 'film.json'},
            'groups': ['sync'], 'skipped': [], 'checks': checks,
            'summary': {s: sum(1 for c in checks if c['status'] == s) for s in ('pass', 'fail', 'warn', 'waived')},
            'ok': ok, 'events': ev, 'sync': sync_rows, 'silences': sil_rows, 'maxDeltaMs': round(max(devs), 4) if devs else 0.0,
            'grid': grid, 'tolMs': tol_ms, 'tempo': tempo_src, 'keys': sorted(keyset)}


def check(film_dir, tol_ms=DEF_TOL_MS, grid=2, silences=(), quiet_db=15.0, out=print, **kw):
    """旧接口：打印核对表，返回是否通过（缺输入时打印原因并返回 False）"""
    try:
        return run_check(film_dir, tol_ms=tol_ms, grid=grid, silences=silences, quiet_db=quiet_db, out=out, **kw)['ok']
    except CliError as e:
        out(f'CUECHECK FAIL（{e.message}）')
        return False


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.cuecheck', description='声画拍点核对：退出码 0 通过、4 超差、2 用法错误、3 缺输入')
    p.add_argument('film', help='作品目录（读 events.json、timeline.json、film.json、out/score_onsets.json、out/mix.wav）')
    p.add_argument('--tol-ms', type=float, default=DEF_TOL_MS, help='打点对整帧 / 网格 / 时间线 / 音乐起音的容差（毫秒，默认 0.5）')
    p.add_argument('--grid', type=float, default=2, help='一拍细分：2 八分（默认）、3 三连、4 十六分……')
    p.add_argument('--keys', default='', help='关键事件集合：事件类型或 cue / id，逗号分隔')
    p.add_argument('--silence', default='', help='要求安静的段落 id（timeline.json 的 secs），逗号分隔')
    p.add_argument('--quiet-db', type=float, default=15.0, help='静默段至少比全片 RMS 低多少 dB（默认 15）')
    p.add_argument('--film-json', dest='film_json', help='film.json（默认 <作品>/film.json）')
    p.add_argument('--events', help='events.json（默认 <作品>/events.json）')
    p.add_argument('--timeline', help='timeline.json（默认 <作品>/timeline.json）')
    p.add_argument('--onsets', help='score_onsets.json（默认 <作品>/out/score_onsets.json）')
    p.add_argument('--mix', help='混音（--measure 与 --silence 用；默认 <作品>/out/mix.wav）')
    p.add_argument('--measure', action='store_true', help='在混音里实测声音事件的起音，按同步容差再判一遍')
    p.add_argument('--early-ms', type=float, help='声音最多可以比画面早多少毫秒（默认 0.25 帧）')
    p.add_argument('--late-frames', type=float, default=1.0, help='声音最多可以比画面晚几帧（默认 1；sync: "lip" 的事件按 2）')
    p.add_argument('--report', help='把报告写成 JSON（附录 C8 的 checks + 逐事件明细）')
    return p


def main_cli(args, ctx):
    if args.grid <= 0:
        raise CliError('usage.bad-value', f'--grid 要正数，收到 {args.grid}')
    if not os.path.isdir(args.film):
        raise CliError('env.film-missing', f'作品目录不存在：{args.film}')
    lines = []
    rep = run_check(args.film, tol_ms=args.tol_ms, grid=args.grid, silences=[s for s in args.silence.split(',') if s],
                    quiet_db=args.quiet_db, keys=args.keys or None, film_json=args.film_json, events=args.events, timeline=args.timeline,
                    onsets=args.onsets, mix=args.mix, measure=args.measure, early_ms=args.early_ms, late_frames=args.late_frames,
                    out=lines.append)
    for ln in lines:
        ctx.out(ln)
    outputs = []
    if args.report:
        p = os.path.abspath(args.report)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({k: v for k, v in rep.items() if not k.startswith('_')}, f, ensure_ascii=False, indent=1)
            f.write('\n')
        outputs.append({'path': _rel(p), 'sha256': sha256_file(p), 'kind': 'cuecheck'})
    data = {k: rep[k] for k in ('ok', 'summary', 'maxDeltaMs', 'grid', 'tolMs', 'tempo', 'keys')}
    # 不通过与告警的逐条原因（--json 时表格不打印，给调用方看这里）
    data['problems'] = ([{'kind': 'hit', 'id': r['id'], 'status': r['status'], 'problems': r['problems']} for r in rep['_rows'] if r['status'] != 'pass']
                        + [{'kind': 'sync', 'id': r['id'], 'audio': r['audio'], 'status': r['status'], 'deltaMs': r.get('deltaMs'), 'problems': r['problems']}
                           for r in rep['sync'] if r['status'] != 'pass']
                        + [{'kind': 'silence', 'id': r['id'], 'status': r['status'], 'problems': []} for r in rep['silences'] if r['status'] != 'pass'])
    if not rep['ok']:
        bad = [c['id'] for c in rep['checks'] if c['status'] == 'fail']
        return {'data': data, 'outputs': outputs, 'error': {'code': 'contract.cuecheck', 'message': '声画拍点核对不通过：' + '、'.join(bad),
                                                           'hint': '逐条偏差见上表（或 --report 的 events / sync）；改时间表的打点或声音脚本的起音'}}
    return {'data': data, 'outputs': outputs}


def main(argv=None):
    return run_cli(main_cli, make_parser(), argv=argv, command='audio:cuecheck')


if __name__ == '__main__':
    sys.exit(main())
