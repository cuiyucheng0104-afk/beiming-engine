# -*- coding: utf-8 -*-
"""{{TITLE}} · 声音：全部程序化合成（engine/audio），同一个种子永远同一段声音；时间全部读 film.json，和画面同源。

声音剧本（与画面的色彩脚本同一条线，routes/directing/DIRECTING.md 步骤 8）：
  S1 远景   远处江面的水声 + 雾里的远风，宽而闷；镜头越推，风越往里收
  切点      声音跟着景别走：S2 一进来，水声换成近处、亮一点，左边加一层拍船的水声（渡船在画左）
  日出前    一口气慢慢吸上来（带通噪声由暗变亮），事件前 6 帧收成近静默——「最重要的一声」靠静默反衬
  sun-break 太阳核心露出远山的那一帧（结果帧），一口青铜古钟（modal_impact）在同一帧起音：偏右（太阳在画右）、长混响；
            钟声之后水声与风回来，低处绽开暖五声持续弦垫（假暖退场、真暖登场）
  title-in  第一笔墨落纸的那一帧：笔杆木音（modal_impact）+ 笔锋触纸轻擦（短促、起音清楚），随后墨洇开的沙沙声缓起缓落；偏左（片名在左上）
混音与母带（五阶段声学引擎）：
  amb / fx / foley / music 四条干线 → volume_curve 推子呼吸包络 → sculpt_stem_eq 互补分槽 EQ → master_chain（−14.0 LUFS / ≤ −1.5 dBTP）。
对位核对：写完 wav 后在混音上测两个事件的起音（钟声、落笔声），和事件帧差超过 1 帧就失败（craft/animation.md §5.7）。
声音不能抢在画面前面：事件帧是结果帧，画面在这一帧已经变了（太阳露头、第一笔墨落纸），声音同帧或稍后起音。

用法：统一出片会自动调用（npm run film -- build films/{{NAME}} 的 mix 步骤，写到运行目录）。单独跑（在仓库根目录）：
  node tools/env/py.mjs films/{{NAME}}/sound.py [films/{{NAME}}] [--out <wav>]
  输出位置：--out > 环境变量 BEIMING_AUDIO_OUT（统一出片设它，指向 out/<运行号>/audio/mix.wav）> films/{{NAME}}/out/mix.wav；
  四条分轨写 BEIMING_AUDIO_STEMS（未设时写 <mix.wav 所在目录>/stems/{amb,fx,foley,music}.wav）。
  48 kHz 立体声 24 bit，积分响度 −14 LUFS、真峰值 ≤ −1.5 dBTP（封装时不再拉响度）。
  解释器由 tools/env/py.mjs 统一选（BEIMING_PYTHON → BEIMING_PY → PYTHON → .venv …）；依赖用 npm run setup 装好（numpy / scipy / numba / soundfile）。
  统一出片另给 BEIMING_FRAMES / BEIMING_FPS：与 film.json 不一致时退出码 4（换了档位却没改作品描述）。
退出码：0 成功；2 用法错误；3 缺 Python 依赖；4 film.json 不合格或声画对位超差。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, ROOT)


def die(code, msg, hint=''):
    sys.stderr.write(f'sound.py：{msg}\n' + (f'下一步：{hint}\n' if hint else ''))
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
        die(4, 'film.json 要是 schemaVersion 2，并有正整数的 output.fps 与 output.frameCount')
    ev = {e.get('id'): e for e in film.get('events') or []}
    for need in ('sun-break', 'title-in'):
        if need not in ev or not isinstance(ev[need].get('frame'), int):
            die(4, f'film.json 的 events 里缺 {need}（整数帧）', '声音读同一张事件表；改了事件 id 要同步改 sound.py')
    cuts = [s['in'] for s in film.get('shots') or [] if isinstance(s.get('in'), int) and s['in'] > 0]
    return film, fps, nf, ev, cuts


def build(film_dir):
    """合成整片声音 → (mix, 上下文, 分轨)。分轨（amb/fx/foley/music）给调音和 QA 掩蔽门检查用；main 只做参数、自检与写文件。"""
    try:
        import numpy as np
        from engine.audio.dsp import SR, N, T, fade, stereo, place, make_ir, reverb, rng, pink, white, bp, lp, hp, svf, smoothstep, undb
        from engine.audio.ambience import wind, water
        from engine.audio.procedural import modal_impact
        from engine.audio.editorial import volume_curve, sculpt_stem_eq
        from engine.audio.mixing import match_level, master_chain
    except ImportError as e:
        die(3, f'缺 Python 依赖：{e}', '在仓库根目录运行 npm run setup，再用 node tools/env/py.mjs 启动（或设 BEIMING_PYTHON 指向装好依赖的解释器）')

    film, fps, nf, EV, cuts = load_film(film_dir)
    # 统一出片给的规格：和作品描述不一致就是换了档位却没改 film.json（变量名写全，环境变量登记检查才认得出）
    for k, got, want in (('BEIMING_FPS', os.environ.get('BEIMING_FPS'), fps), ('BEIMING_FRAMES', os.environ.get('BEIMING_FRAMES'), nf)):
        if got and abs(float(got) - want) > 1e-9:
            die(4, f'{k}={got} 与 film.json 的 {want} 不一致', '改 film.json 的 output（或按 film.json 的档位出片），声音和画面才对得上')
    D = nf / fps                       # 时长 = 帧数 ÷ 帧率，和画面逐样本对齐
    n = N(D)
    t = T(D)
    t_sun = EV['sun-break']['frame'] / fps
    t_title = EV['title-in']['frame'] / fps
    t_cut = cuts[0] / fps if cuts else D / 2
    xf = 3 / fps                       # 切点上的交叉淡化：3 帧

    def ramp(a0, a1, x):               # a0 → a1 秒内从 0 升到 1
        return smoothstep(a0, a1, x)

    # ── 1. 环境干线 amb：S1 远水 + 远风；S2 近水 + 拍船声（受景别声像上限约束）。切点 3 帧交叉，钟前 volume_curve 挖出负空间 ──
    far_w, _, _ = match_level(water(D, 11, 'far'), -25.0, 'win', 0.0, D)
    near_w = water(D, 13, 'far')
    near_w, _, _ = match_level(hp(near_w, 220, 2) + lp(near_w, 900, 2) * 0.35, -23.5, 'win', 0.0, D)
    hull, _, _ = match_level(stereo(water(D, 17, 'hull').mean(1), -0.35), -29.5, 'win', 0.0, D)
    air, _ = wind(D, 7, 'far')
    air, _, _ = match_level(air, -27.5, 'win', 0.0, D)
    s2 = ramp(t_cut - xf / 2, t_cut + xf / 2, t)[:, None]
    wind_ride = volume_curve(n, [(0.0, 0.0), (t_cut, -3.5), (D, -4.0)], dur=D)
    amb_dip = volume_curve(
        n,
        [
            (0.0, 0.0),
            (max(0.0, t_sun - 8 / fps), 0.0),
            (max(0.0, t_sun - 2 / fps), -14.0),
            (min(D, t_sun + 0.15), -14.0),
            (min(D, t_sun + 0.95), 0.0),
        ],
        dur=D,
    )
    amb = (far_w * (1 - s2) + (near_w + hull) * s2 + air * wind_ride) * amb_dip

    # ── 2. 硬效干线 fx：日出前一口气渐起（事件前 6 帧收住）+ modal_impact 青铜古钟在 t_sun 准帧敲响 ──
    r = rng(23)
    swell_on = ramp(t_cut - 0.4, t_sun - 6 / fps, t) * (1 - ramp(t_sun - 6 / fps, t_sun - 1 / fps, t))
    src = np.stack([pink(n, r), pink(n, r)], 1)
    swell = svf(src, 300 + 1500 * ramp(t_cut, t_sun, t), 0.9, 'bp') * (swell_on ** 1.5)[:, None]
    swell, _, _ = match_level(swell, -26.5, 'mom', t_cut, t_sun)

    bell_dur = max(0.4, D - t_sun)
    bell_mono, _ = modal_impact(
        'bronze_bell',
        dur=bell_dur,
        hardness=0.64,
        size_scale=2.98,
        damp_scale=0.28,
        key='F',
        seed=31,
    )
    bells = np.zeros((n, 2))
    place(bells, bell_mono, t_sun, 1.0, 0.28)
    bells = reverb(bells, make_ir(rt=3.4, pre=0.028, seed=5, length=min(4.2, D)), wet=0.50, dry=1.0, cross=0.35)
    bells, _, _ = match_level(bells, -14.8, 'mom', t_sun, min(D, t_sun + 1.5))
    fx = swell + bells

    # ── 3. 拟音干线 foley：modal_impact 硬木笔杆微叩 + 笔锋触纸高频脆擦（t_title 准帧起音）+ 宣纸墨洇沙沙 ──
    rk = rng(41)
    td = max(0.05, min(0.14, D - t_title))
    tt = T(td)
    wood_tap, _ = modal_impact('wood_hollow', dur=td, hardness=0.76, size_scale=0.82, damp_scale=1.35, seed=42)
    tick = bp(white(N(td), rk), 2800, 9600, 2) * smoothstep(0, 0.0012, tt) * np.exp(-tt / 0.022)
    touch = np.zeros((n, 2))
    place(touch, tick + wood_tap * 0.55, t_title, 1.0, -0.32)
    touch, _, _ = match_level(touch, -20.5, 'mom', t_title, min(D, t_title + 0.4))

    ink_d = max(0.08, min(1.4, D - t_title))
    ink_t = T(ink_d)
    ink = bp(white(N(ink_d), rk), 1800, 7500, 2) * (smoothstep(0.03, 0.30, ink_t) * np.exp(-np.maximum(0, ink_t - 0.30) / 0.45))
    inks = np.zeros((n, 2))
    place(inks, ink, t_title, 1.0, -0.30)
    inks, _, _ = match_level(inks, -28.5, 'mom', t_title, min(D, t_title + ink_d))
    foley = reverb(touch + inks, make_ir(rt=0.45, pre=0.005, seed=8, length=min(0.8, D)), wet=0.10, dry=1.0, cross=0.30)

    # ── 4. 配乐干线 music：日出钟响后绽开的 F 大调五声加九和弦暖垫（假暖退场、真暖登场） ──
    pad_mono = (
        np.sin(2 * np.pi * 87.31 * t) * 0.48
        + np.sin(2 * np.pi * 130.81 * t + 0.9) * 0.42
        + np.sin(2 * np.pi * 174.61 * t + 1.8) * 0.34
        + np.sin(2 * np.pi * 196.00 * t + 2.5) * 0.22
        + np.sin(2 * np.pi * 261.63 * t + 0.4) * 0.18
        + np.sin(2 * np.pi * 349.23 * t + 1.3) * 0.10
    )
    pad_st = reverb(
        stereo(lp(pad_mono, 1800, 2), 0.08),
        make_ir(rt=2.8, pre=0.03, seed=9, length=min(3.4, D)),
        wet=0.38,
        dry=0.85,
        cross=0.42,
    )
    music_env = volume_curve(
        n,
        [
            (0.0, -54.0),
            (max(0.0, t_sun + 0.08), -42.0),
            (min(D, t_sun + 1.25), 0.0),
            (max(0.0, D - 0.40), 0.0),
            (D, -16.0),
        ],
        dur=D,
    )
    music = pad_st * music_env
    win_start = min(max(0.0, D - 0.6), t_sun + 1.1)
    music, _, _ = match_level(music, -17.5, 'win', win_start, D)

    # ── 5. 互补 EQ 分槽 + 推子首尾呼吸 + 四步透明母带收口（−14.0 LUFS / ≤ −1.5 dBTP） ──
    edge_ride = volume_curve(n, [(0.0, -28.0), (0.22, 0.0), (max(0.25, D - 0.32), 0.0), (D, -28.0)], dur=D)
    sculpted = sculpt_stem_eq({
        'amb': fade(amb * edge_ride, 0.08, 0.16),
        'fx': fade(fx * edge_ride, 0.02, 0.16),
        'foley': fade(foley * edge_ride, 0.02, 0.16),
        'music': fade(music * edge_ride, 0.08, 0.20),
    })
    pre = sculpted['amb'] + sculpted['fx'] + sculpted['foley'] + sculpted['music']
    mix, diag = master_chain(pre, target_lufs=-14.0, max_tp=-1.5)
    gain_db = float(diag['masterGainDb'])
    post_g = float(undb(gain_db))

    stems = {}
    for k, v in sculpted.items():
        s = fade(v * post_g, min(0.006, D * 0.02), min(0.020, D * 0.04))
        pk = float(np.max(np.abs(s))) if len(s) else 0.0
        if pk > 0.96:
            s = s * (0.94 / pk)
        if len(s):
            s[0] = 0.0
            s[-1] = 0.0
        stems[k] = s

    ctx = {'fps': fps, 'n': n, 't_sun': t_sun, 't_title': t_title, 'EV': EV, 'gain_db': gain_db, 'SR': SR, 'master': diag}
    return mix, ctx, stems


def strike(mix, t0, fps, sr, half=6):
    """事件附近（±half 帧）响度上升最陡的时刻：4 ms 包络的对数在 4 ms 内的最大升幅。比峰值门限稳，不会被水声颗粒骗。
    全频带与 2.5–12 kHz 两路各找一次，取升幅大的那一路（钟声的余音很响时，轻的高频擦声在全频带里显不出来，高频里很清楚；
    QA 门 tools/qa 的起音检测也是这两路）。"""
    import numpy as np
    from scipy.ndimage import uniform_filter1d
    from engine.audio.dsp import bp
    w = max(1, int(round(0.004 * sr)))
    a, b = max(0, int(round((t0 - half / fps) * sr))), min(len(mix), int(round((t0 + half / fps) * sr)))
    pre = max(0, a - int(0.05 * sr))                      # 带通先跑 50 ms 再取，避开滤波器的起振
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
    ap = argparse.ArgumentParser(description='程序化合成本片声音，写 48 kHz 立体声 wav 与四条分轨')
    ap.add_argument('film', nargs='?', default=HERE, help='作品目录（默认本文件所在目录）')
    ap.add_argument('--out', help='输出 wav（默认 <作品目录>/out/mix.wav）')
    a = ap.parse_args()
    film_dir = os.path.abspath(a.film)
    mix, ctx, stems = build(film_dir)
    import numpy as np
    import soundfile as sf
    from engine.audio.meter import integrated, true_peak
    fps, n, EV, SR, gain_db = ctx['fps'], ctx['n'], ctx['EV'], ctx['SR'], ctx['gain_db']

    # ── 自检：时长逐样本对齐；钟声、落笔声的起音与各自的事件同帧（声音不早于画面，晚不超过 1 帧）；响度与真峰值 ──
    if len(mix) != n:
        die(4, f'声音长 {len(mix)} 样本，画面要 {n}')
    onsets = {}
    gap = abs(EV['title-in']['frame'] - EV['sun-break']['frame'])
    for eid, what in (('sun-break', '钟声'), ('title-in', '落笔声')):
        t0 = EV[eid]['frame'] / fps
        on = strike(mix, t0, fps, SR, half=max(1, min(6, gap // 2)))
        if on is None or on < t0 - 0.25 / fps or on > t0 + 1 / fps:
            die(4, f'{what}起音 {on} 秒，与 {eid}（第 {EV[eid]["frame"]} 帧 = {t0:.4f} 秒）对不上（要同帧或晚不超过 1 帧）',
                f'检查 {what}的摆放与事件表；不要手抄秒数')
        onsets[eid] = {'frame': EV[eid]['frame'], 'onset': on, 'errFrames': round((on - t0) * fps, 3)}
    lufs, tp = integrated(mix), 20 * np.log10(true_peak(mix) + 1e-12)

    out = a.out or os.environ.get('BEIMING_AUDIO_OUT') or os.path.join(film_dir, 'out', 'mix.wav')
    out_abs = os.path.abspath(out)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    tmp = out_abs + '.part.wav'
    sf.write(tmp, mix.astype(np.float32), SR, subtype='PCM_24')
    os.replace(tmp, out_abs)

    stems_dir = os.environ.get('BEIMING_AUDIO_STEMS') or os.path.join(os.path.dirname(out_abs), 'stems')
    os.makedirs(stems_dir, exist_ok=True)
    for k, st_arr in stems.items():
        sp = os.path.join(stems_dir, f'{k}.wav')
        st_tmp = sp + '.part.wav'
        sf.write(st_tmp, st_arr.astype(np.float32), SR, subtype='PCM_24')
        os.replace(st_tmp, sp)

    try:
        shown = os.path.relpath(out_abs, ROOT).replace(os.sep, '/')
    except ValueError:                 # Windows 上跨盘符
        shown = os.path.basename(out_abs)
    print(json.dumps({'path': shown if not shown.startswith('..') else os.path.basename(out_abs), 'seconds': round(len(mix) / SR, 4),
                      'lufs': round(lufs, 2), 'truePeakDbTP': round(float(tp), 2), 'gainDb': round(float(gain_db), 2),
                      'stems': sorted(stems), 'events': onsets},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
