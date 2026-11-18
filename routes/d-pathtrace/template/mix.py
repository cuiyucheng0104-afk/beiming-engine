# -*- coding: utf-8 -*-
"""《{{TITLE}}》· 物理光追路线模版声音：48 kHz 立体声全程序化合成（engine/audio），时间唯一取自 film.json。

声音结构（对应 S01 微距掠射扫光 → S02 黑曜石镜面揭示）：
  · 环境底床：深腔冷钢共鸣与柔和气流，第 34–39 帧（reveal-lock 前 6 帧）压低约 14 dB 形成近静默反衬
  · sweep-strike（第 12 帧，S01）：高光灯刃掠过钨钢主棱，2 ms 起音的高频金属非谐泛音擦击（偏左→中）
  · reveal-lock（第 40 帧，S02）：低频锻砧落锁闷击 + 澄澈晶圆高频锁定瞬态同帧起音，随后展开 D 大三和弦金属余韵
  · 响度与自检：母带归一至 −14.0 LUFS、真峰值 ≤ −1.5 dBTP；写出前自检总样本数与两处事件的起音误差（≤ 1 帧）。

运行：统一出片自动调用（写至 BEIMING_AUDIO_OUT）；单独运行在仓库根目录执行：
  node tools/env/py.mjs films/{{NAME}}/mix.py [films/{{NAME}}] [--out <wav>]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)


def die(code, msg, hint=''):
    sys.stderr.write(f'mix.py：{msg}\n' + (f'下一步：{hint}\n' if hint else ''))
    sys.exit(code)


def load_film(film_dir):
    path = os.path.join(film_dir, 'film.json')
    try:
        with open(path, encoding='utf-8') as f:
            film = json.load(f)
    except (OSError, ValueError) as e:
        die(4, f'读不了 {path}：{e}')
    out = film.get('output') or {}
    fps, nf = out.get('fps'), out.get('frameCount')
    if film.get('schemaVersion') != 2 or not (isinstance(fps, int) and fps > 0 and isinstance(nf, int) and nf > 0):
        die(4, 'film.json 须为 schemaVersion 2，且含正整数 output.fps 与 output.frameCount')
    ev = {e.get('id'): e for e in (film.get('events') or []) if isinstance(e, dict) and e.get('id')}
    for need in ('sweep-strike', 'reveal-lock'):
        if need not in ev or not isinstance(ev[need].get('frame'), int):
            die(4, f'film.json 的 events 缺少整数帧事件 {need}', '改了事件 id 时请同步更新 mix.py')
    cuts = [s['in'] for s in (film.get('shots') or []) if isinstance(s, dict) and isinstance(s.get('in'), int) and s['in'] > 0]
    return film, fps, nf, ev, cuts


def build(film_dir):
    try:
        import numpy as np
        from engine.audio.dsp import SR, N, T, fade, place, make_ir, reverb, rng, pink, white, bp, lp, hp, smoothstep
        from engine.audio.mixing import loudness_to, match_level
    except ImportError as e:
        die(3, f'缺 Python 依赖：{e}', '在仓库根目录运行 npm run setup，再用 node tools/env/py.mjs 启动')

    film, fps, nf, ev, cuts = load_film(film_dir)
    for k, got, want in (('BEIMING_FPS', os.environ.get('BEIMING_FPS'), fps), ('BEIMING_FRAMES', os.environ.get('BEIMING_FRAMES'), nf)):
        if got and abs(float(got) - want) > 1e-9:
            die(4, f'{k}={got} 与 film.json 的 {want} 不一致', '请保持交付档位帧率/帧数与 film.json 一致')

    dur = nf / fps
    n = N(dur)
    t = T(dur)
    t_sweep = ev['sweep-strike']['frame'] / fps
    t_lock = ev['reveal-lock']['frame'] / fps
    t_cut = cuts[0] / fps if cuts else dur * 0.5

    # 1. 深腔冷钢环境床：低频无人机共鸣 + 柔和带通气流，在 reveal-lock 前 6 帧抽空反衬
    r_bed = rng(2026)
    air_raw = np.stack([bp(pink(n, r_bed), 140, 1100, 2), bp(pink(n, r_bed), 150, 1150, 2)], axis=1)
    drone_mono = (
        0.55 * np.sin(2 * np.pi * 73.42 * t)
        + 0.30 * np.sin(2 * np.pi * 110.0 * t + 0.6)
        + 0.15 * np.sin(2 * np.pi * 146.83 * t + 1.3)
    ) * (0.75 + 0.25 * smoothstep(0.0, t_cut, t))
    drone = np.stack([lp(drone_mono, 360, 2), lp(drone_mono * 0.98, 360, 2)], axis=1)
    bed, _, _ = match_level(air_raw * 0.35 + drone * 0.65, -26.5, 'win', 0.0, dur)

    dip_sweep = 1.0 - 0.72 * smoothstep(t_sweep - 5 / fps, t_sweep - 1.5 / fps, t) * (1.0 - smoothstep(t_sweep + 0.06, t_sweep + 0.32, t))
    dip_lock = 1.0 - 0.85 * smoothstep(t_lock - 6 / fps, t_lock - 1.5 / fps, t) * (1.0 - smoothstep(t_lock + 0.08, t_lock + 0.45, t))
    bed = bed * (dip_sweep * dip_lock)[:, None]

    # 2. 第 12 帧 sweep-strike：掠射灯刃金属谐波瞬态（2 ms 锐利起音 + 钨钢高频泛音簇）
    r_sw = rng(37)
    d_sw = min(0.75, max(0.12, dur - t_sweep))
    tt_sw = T(d_sw)
    sw_atk = smoothstep(0.0, 0.002, tt_sw)
    sw_body = (
        0.90 * np.sin(2 * np.pi * 587.33 * tt_sw) * np.exp(-tt_sw / 0.16)
        + 0.62 * np.sin(2 * np.pi * 1174.66 * tt_sw + 0.4) * np.exp(-tt_sw / 0.11)
        + 0.44 * np.sin(2 * np.pi * 1760.00 * tt_sw + 1.1) * np.exp(-tt_sw / 0.07)
        + 0.32 * np.sin(2 * np.pi * 2637.02 * tt_sw + 2.0) * np.exp(-tt_sw / 0.045)
    ) * sw_atk
    sw_spark = bp(white(N(d_sw), r_sw), 2400, 9200, 2) * sw_atk * np.exp(-tt_sw / 0.018) * 0.85
    sweep_stem = np.zeros((n, 2))
    place(sweep_stem, sw_body + sw_spark, t_sweep, 1.0, -0.18)
    sweep_stem = reverb(sweep_stem, make_ir(rt=1.3, pre=0.012, seed=11, length=min(1.6, dur)), wet=0.28, dry=1.0)
    sweep_stem, _, _ = match_level(sweep_stem, -16.5, 'mom', t_sweep, min(dur, t_sweep + 0.5))

    # 3. 第 40 帧 reveal-lock：重型黑曜石锻砧落锁 + 微晶铭牌锁定高频泛音 + D 大调金属余韵
    r_lk = rng(73)
    d_lk = max(0.2, dur - t_lock)
    tt_lk = T(d_lk)
    lk_atk = smoothstep(0.0, 0.002, tt_lk)
    pitch_drop = 112.0 - 48.0 * smoothstep(0.0, 0.055, tt_lk)
    thump = np.sin(2 * np.pi * np.cumsum(pitch_drop) / SR) * lk_atk * np.exp(-tt_lk / 0.14) * 0.95
    click = bp(white(N(d_lk), r_lk), 2800, 10500, 2) * lk_atk * np.exp(-tt_lk / 0.014) * 0.95
    chime = (
        0.75 * np.sin(2 * np.pi * 293.66 * tt_lk) * np.exp(-tt_lk / 0.85)
        + 0.52 * np.sin(2 * np.pi * 440.00 * tt_lk + 0.5) * np.exp(-tt_lk / 0.72)
        + 0.38 * np.sin(2 * np.pi * 739.99 * tt_lk + 1.2) * np.exp(-tt_lk / 0.55)
        + 0.28 * np.sin(2 * np.pi * 1174.66 * tt_lk + 1.9) * np.exp(-tt_lk / 0.35)
    ) * lk_atk
    lock_stem = np.zeros((n, 2))
    place(lock_stem, thump + click + chime, t_lock, 1.0, 0.08)
    lock_stem = reverb(lock_stem, make_ir(rt=2.1, pre=0.018, seed=19, length=min(2.2, dur)), wet=0.36, dry=1.0)
    lock_stem, _, _ = match_level(lock_stem, -14.8, 'mom', t_lock, min(dur, t_lock + 0.9))

    # 首尾温和包络（首 0.12s、尾 0.22s，不伤第 12 帧与第 40 帧瞬态）
    raw_mix = fade(bed + sweep_stem + lock_stem, 0.12, 0.22)
    mix, gain_db, _ = loudness_to(raw_mix, -14.0, -1.5)
    return mix, {'fps': fps, 'n': n, 'ev': ev, 'SR': SR, 'gain_db': float(gain_db)}


def detect_onset(mix, t0, fps, sr, half=5):
    import numpy as np
    from scipy.ndimage import uniform_filter1d
    from engine.audio.dsp import bp
    w = max(1, int(round(0.004 * sr)))
    a = max(0, int(round((t0 - half / fps) * sr)))
    b = min(len(mix), int(round((t0 + half / fps) * sr)))
    pre = max(0, a - int(0.05 * sr))
    best = None
    for band in (None, (2500, 12000)):
        x = mix[pre:b] if band is None else bp(mix[pre:b], band[0], band[1], 2)
        x = x[a - pre:]
        env = 20 * np.log10(np.sqrt(uniform_filter1d((x ** 2).mean(1), w)) + 1e-9)
        rise = env[w:] - env[:-w]
        k = int(np.argmax(rise))
        if best is None or rise[k] > best[0]:
            best = (float(rise[k]), k)
    return round((a + best[1] + w // 2) / sr, 4)


def main():
    ap = argparse.ArgumentParser(description='生成 D 路线模版 48 kHz 立体声音轨并核对事件同步')
    ap.add_argument('film', nargs='?', default=HERE, help='作品目录（默认脚本所在目录）')
    ap.add_argument('--out', help='输出 wav 路径（默认读 BEIMING_AUDIO_OUT，否则 <作品目录>/out/mix.wav）')
    args = ap.parse_args()
    film_dir = os.path.abspath(args.film)
    mix, ctx = build(film_dir)

    import numpy as np
    import soundfile as sf
    from engine.audio.meter import integrated, true_peak

    fps, n, ev, sr, gain_db = ctx['fps'], ctx['n'], ctx['ev'], ctx['SR'], ctx['gain_db']
    if len(mix) != n:
        die(4, f'样本数 {len(mix)} 与期望帧长 {n} 不一致')

    onsets = {}
    for eid, label in (('sweep-strike', '掠射金属声'), ('reveal-lock', '锻砧落锁声')):
        t0 = ev[eid]['frame'] / fps
        on = detect_onset(mix, t0, fps, sr)
        if on < t0 - 0.25 / fps or on > t0 + 1.0 / fps:
            die(4, f'{label}起音 {on}s 与事件 {eid}（第 {ev[eid]["frame"]} 帧 = {t0:.4f}s）偏差超限')
        onsets[eid] = {'frame': ev[eid]['frame'], 'onset': on, 'errFrames': round((on - t0) * fps, 3)}

    lufs = float(integrated(mix))
    tp_db = float(20 * np.log10(true_peak(mix) + 1e-12))

    out = args.out or os.environ.get('BEIMING_AUDIO_OUT') or os.path.join(film_dir, 'out', 'mix.wav')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + '.part.wav'
    sf.write(tmp, mix.astype(np.float32), sr, subtype='PCM_24')
    os.replace(tmp, out)

    try:
        shown = os.path.relpath(out, ROOT).replace(os.sep, '/')
    except ValueError:
        shown = os.path.basename(out)
    print(json.dumps({
        'path': shown if not shown.startswith('..') else os.path.basename(out),
        'seconds': round(len(mix) / sr, 4),
        'lufs': round(lufs, 2),
        'truePeakDbTP': round(tp_db, 2),
        'gainDb': round(gain_db, 2),
        'events': onsets,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
