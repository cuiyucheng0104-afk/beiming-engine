# -*- coding: utf-8 -*-
"""北冥引擎 · 声画拍点核对：events.json 里每个带 cue 的画面打点，量它离整帧、离节拍网格、离时间线、离音乐起音各有多远；
可选地检查静默段里没有音符起音、而且确实安静。超过容差就以非零码退出，挡在出片之前。

用法（在仓库根目录）：
  python -m engine.audio.cuecheck <影片目录> [--tol-ms 0.5] [--grid 2] [--silence 段落id[,段落id]] [--quiet-db 15]
读：<影片>/events.json（engine/render/events.mjs 导出）、<影片>/timeline.json（含 fps、secs，可选 t = {cue: 秒}）、
    <影片>/out/score_onsets.json（engine/audio/cues.py 的 Onsets.dump 写出，可缺）、<影片>/out/mix.wav（只在查静默时用）。

接口：
  check(film_dir, tol_ms=0.5, grid=2, silences=(), quiet_db=15.0, out=print) → bool
    grid = 网格细分：2 是八分音符；silences 是 timeline.secs 里要求安静的段落 id
    静默段的判定：段内（t0 ≤ 起音 < t1）没有音符起音，且 [t0+0.3, t1−0.02] 的 RMS 比全片低 quiet_db 以上
"""
import argparse
import json
import os
import sys

import numpy as np

from .cues import Tempo


def check(film_dir, tol_ms=0.5, grid=2, silences=(), quiet_db=15.0, out=print):
    here = os.path.abspath(film_dir)
    TL = json.load(open(os.path.join(here, 'timeline.json')))
    EV = json.load(open(os.path.join(here, 'events.json')))['ev']
    so_path = os.path.join(here, 'out', 'score_onsets.json')
    SO = json.load(open(so_path)) if os.path.exists(so_path) else {'onsets': {}, 'notes': []}
    FPS = TL['fps']
    tempo = Tempo(TL['secs'], FPS, digits=None)
    tl_t = TL.get('t', {})

    rows, worst = [], 0.0
    for e in EV:
        c = e.get('cue')
        if not c:
            continue
        t = e['t']
        f = tempo.off_frame(t)
        g = tempo.off_grid(t, grid)
        tl = abs(t - tl_t[c]) if c in tl_t else 0.0
        m = SO['onsets'].get(c)
        md = abs(t - m) if m is not None else None
        devs = [f, g, tl] + ([md] if md is not None else [])
        worst = max(worst, max(devs))
        s = tempo.section(t)
        bar_beat = (t - s['t0']) / (60 / s['bpm'])
        rows.append((c, t, round(t * FPS), f"{s['id']}{int(bar_beat // s['meter']) + 1}.{bar_beat % s['meter'] + 1:.1f}",
                     f * 1e3, g * 1e3, tl * 1e3, None if md is None else md * 1e3))

    out(f"{'cue':9} {'t (s)':>8} {'frame':>5}  {'bar.beat':9} {'frame ms':>8} {'grid ms':>8} {'tl ms':>6} {'music ms':>9}")
    for c, t, fr, bb, f, g, tl, md in rows:
        out(f"{c:9} {t:8.4f} {fr:5d}  {bb:9} {f:8.3f} {g:8.3f} {tl:6.3f} {'   (fx)' if md is None else f'{md:9.3f}'}")
    untagged = [c for c, *_ in rows if c not in SO['onsets']]
    out(f"\n{len(rows)} visual hits · {len(rows) - len(untagged)} with a tagged music note · max deviation {worst * 1e3:.3f} ms")
    if untagged:
        out('carried by foley only (no music note): ' + ', '.join(untagged))

    ok = worst <= tol_ms * 1e-3
    if silences:
        import soundfile as sf
        x, sr = sf.read(os.path.join(here, 'out', 'mix.wav'))
        mono = x.mean(1) if x.ndim == 2 else x

        def rms_db(a, b):
            y = mono[int(a * sr):int(b * sr)]
            return 20 * np.log10(np.sqrt(np.mean(y ** 2)) + 1e-12)

        full = rms_db(0, TL['dur'])
        for sid in silences:
            S = tempo.by_id[sid]
            inside = [n for n in SO['notes'] if S['t0'] <= n < S['t1'] - 1e-6]
            sil = rms_db(S['t0'] + .3, S['t1'] - .02)
            after = rms_db(S['t1'], S['t1'] + .5)
            out(f"silence {S['t0']}–{S['t1']} s: {len(inside)} note onsets · RMS {sil:.1f} dBFS (film {full:.1f}, "
                f"first 0.5 s after {after:.1f}) → {after - sil:.1f} dB jump")
            ok = ok and not inside and full - sil >= quiet_db
    out('CUECHECK ' + ('OK' if ok else 'FAIL'))
    return ok


def main(argv=None):
    p = argparse.ArgumentParser(description='声画拍点核对')
    p.add_argument('film')
    p.add_argument('--tol-ms', type=float, default=0.5)
    p.add_argument('--grid', type=float, default=2)
    p.add_argument('--silence', default='')
    p.add_argument('--quiet-db', type=float, default=15.0)
    a = p.parse_args(argv)
    sil = [s for s in a.silence.split(',') if s]
    return 0 if check(a.film, a.tol_ms, a.grid, sil, a.quiet_db) else 1


if __name__ == '__main__':
    sys.exit(main())
