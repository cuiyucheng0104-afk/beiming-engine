# -*- coding: utf-8 -*-
"""{{TITLE}} · 声音：全部程序化合成（engine/audio），同一个种子永远同一段声音；时间全部读 film.json，和画面同源。

声音剧本（与画面的色彩脚本同一条线，routes/directing/DIRECTING.md 步骤 8）：
  S1 远景   远处江面的水声 + 雾里的远风，宽而闷；镜头越推，风越往里收
  切点      声音跟着景别走：S2 一进来，水声换成近处、亮一点，左边加一层拍船的水声（渡船在画左）
  日出前    一口气慢慢吸上来（带通噪声由暗变亮），事件前 6 帧收成近静默——「最重要的一声」靠静默反衬
  sun-break 太阳核心露出远山的那一帧（结果帧），一口铜钟在同一帧起音：偏右（太阳在画右）、长混响；
            钟声之后水声与风回来，低处垫一层暖的持续音（假暖退场、真暖登场）
  title-in  片名显影：一声很轻的纸上洇墨（宽带噪声缓起缓落），偏左上（片名在左上）
对位核对：写完 wav 后在混音上测钟声的起音，和 sun-break 的帧差超过 1 帧就失败（craft/animation.md §5.7）。

用法（在仓库根目录）：python films/{{NAME}}/sound.py [films/{{NAME}}] [--out <wav>]
  默认写 films/{{NAME}}/out/mix.wav（48 kHz 立体声 24 bit，积分响度 −14 LUFS、真峰值 ≤ −1.5 dBTP；封装时不再拉响度）
  Python 用仓库约定的解释器（环境变量 PYTHON），依赖见 requirements.txt（numpy / scipy / numba / soundfile）。
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
    """合成整片声音 → (mix, 上下文, 分轨)。分轨给调音和检查用；main 只做参数、自检与写文件。"""
    try:
        import numpy as np
        import soundfile as sf
        from engine.audio.dsp import SR, N, T, fade, stereo, place, make_ir, reverb, rng, pink, white, bp, lp, hp, svf, smoothstep
        from engine.audio.ambience import wind, water
        from engine.audio.mixing import loudness_to, match_level
    except ImportError as e:
        die(3, f'缺 Python 依赖：{e}', '用装了 requirements.txt 的解释器运行（环境变量 PYTHON 指向它）')

    film, fps, nf, EV, cuts = load_film(film_dir)
    D = nf / fps                       # 时长 = 帧数 ÷ 帧率，和画面逐样本对齐
    n = N(D)
    t = T(D)
    t_sun = EV['sun-break']['frame'] / fps
    t_title = EV['title-in']['frame'] / fps
    t_cut = cuts[0] / fps if cuts else D / 2
    xf = 3 / fps                       # 切点上的交叉淡化：3 帧

    def ramp(a0, a1, x):               # a0 → a1 秒内从 0 升到 1
        return smoothstep(a0, a1, x)

    # 电平一律按响度定（match_level），不按样本幅度瞎乘：环境是底，钟声靠前面的近静默反衬（B 类「最重要的一声」）。
    # ── 环境：S1 远水 + 远风；S2 近水 + 拍船声（渡船在画左）。切点上 3 帧交叉淡化，声音跟着景别走 ──
    far_w, _, _ = match_level(water(D, 11, 'far'), -24.0, 'win', 0.0, D)
    near_w = water(D, 13, 'far')
    near_w, _, _ = match_level(hp(near_w, 220, 2) + lp(near_w, 900, 2) * 0.35, -22.5, 'win', 0.0, D)   # 近一点：中高频更清楚
    hull, _, _ = match_level(stereo(water(D, 17, 'hull').mean(1), -0.55), -29.0, 'win', 0.0, D)       # 拍船声偏左
    air, _ = wind(D, 7, 'far')
    air, _, _ = match_level(air, -27.0, 'win', 0.0, D)
    s2 = ramp(t_cut - xf / 2, t_cut + xf / 2, t)[:, None]
    wind_g = (1.0 - 0.35 * ramp(0, t_cut, t))[:, None]                     # 推镜时风往里收
    bed = far_w * (1 - s2) + (near_w + hull) * s2 + air * wind_g

    # ── 日出前的一口气：带通噪声由暗变亮，事件前 6 帧收住 ──
    r = rng(23)
    swell_on = ramp(t_cut - 0.4, t_sun - 6 / fps, t) * (1 - ramp(t_sun - 6 / fps, t_sun - 1 / fps, t))
    src = np.stack([pink(n, r), pink(n, r)], 1)
    swell = svf(src, 300 + 1500 * ramp(t_cut, t_sun, t), 0.9, 'bp') * (swell_on ** 1.5)[:, None]
    swell, _, _ = match_level(swell, -26.0, 'mom', t_cut, t_sun)
    # 近静默：钟前 8→2 帧把环境压下去约 14 dB，钟响后 0.15–0.95 秒回来
    dip = 1 - 0.8 * ramp(t_sun - 8 / fps, t_sun - 2 / fps, t) * (1 - ramp(t_sun + 0.15, t_sun + 0.95, t))
    bed = bed * dip[:, None]

    # ── 铜钟：非谐和分音（每个分音一对略失谐的正弦，拍频给出铜钟的「嗡」）+ 敲击瞬态；起音就在 t_sun 那个样本 ──
    def bell(f0, d, seed):
        tt = T(d)
        rr = rng(seed)
        parts = [(0.5, 0.55, 7.0), (1.0, 1.0, 5.0), (1.183, 0.42, 3.2), (1.506, 0.32, 2.4), (2.0, 0.46, 2.0),
                 (2.514, 0.22, 1.3), (2.662, 0.18, 1.1), (3.011, 0.12, 0.8), (4.166, 0.06, 0.45)]
        x = np.zeros(len(tt))
        for ratio, amp, tau in parts:
            f = f0 * ratio
            beat = 0.6 + 0.9 * rr.random()
            x += amp * np.exp(-tt / tau) * (np.sin(2 * np.pi * f * tt + rr.random() * 6.28) + 0.6 * np.sin(2 * np.pi * (f + beat) * tt))
        x *= smoothstep(0, 0.003, tt)                                    # 3 ms 起音，不咔
        hit = bp(white(N(0.03), rr), 900, 5200, 2) * np.exp(-np.arange(N(0.03)) / (0.006 * SR)) * 0.9
        x[:len(hit)] += hit
        return x / (np.abs(x).max() + 1e-12)

    bells = np.zeros((n, 2))
    place(bells, bell(174.6, D - t_sun, 31), t_sun, 1.0, 0.32)          # F3：低而暖；偏右（太阳在画右）
    bells = reverb(bells, make_ir(rt=3.6, pre=0.03, seed=5, length=min(4.5, D)), wet=0.55, dry=1.0)
    bells, _, _ = match_level(bells, -15.0, 'mom', t_sun, min(D, t_sun + 1.5))

    # ── 钟后：一层很低的暖持续音（五度叠成的柔和长音，慢起），撑住「真暖」 ──
    tw = t - t_sun
    warm_env = ramp(0.2, 1.6, tw) * (tw > 0)
    warm = (np.sin(2 * np.pi * 87.3 * t) * 0.6 + np.sin(2 * np.pi * 130.8 * t + 1.1) * 0.35 + np.sin(2 * np.pi * 174.6 * t + 2.3) * 0.18)
    warm, _, _ = match_level(stereo(lp(warm * warm_env, 600, 2), 0.1), -27.0, 'win', min(D - 0.5, t_sun + 1.6), D)

    # ── 片名洇墨：宽带噪声缓起缓落（约 1.2 秒），偏左（片名在左上） ──
    ink_d = min(1.4, D - t_title)
    ink_t = T(ink_d)
    rk = rng(41)
    ink = bp(white(N(ink_d), rk), 1800, 7500, 2) * (smoothstep(0, 0.25, ink_t) * np.exp(-np.maximum(0, ink_t - 0.25) / 0.45))
    inks = np.zeros((n, 2))
    place(inks, ink, t_title, 1.0, -0.45)
    inks, _, _ = match_level(inks, -30.0, 'mom', t_title, min(D, t_title + ink_d))

    stems = {'bed': bed, 'swell': swell, 'bell': bells, 'warm': warm, 'ink': inks}
    mix = fade(sum(stems.values()), 0.25, 0.35)
    mix, gain_db, _ = loudness_to(mix, -14.0, -1.5)
    ctx = {'fps': fps, 'n': n, 't_sun': t_sun, 'EV': EV, 'gain_db': float(gain_db), 'SR': SR}
    return mix, ctx, stems


def strike(mix, t0, fps, sr):
    """事件附近（±6 帧）响度上升最陡的时刻：4 ms 包络的对数在 4 ms 内的最大升幅。比峰值门限稳，不会被水声颗粒骗。"""
    import numpy as np
    from scipy.ndimage import uniform_filter1d
    w = max(1, int(round(0.004 * sr)))
    a, b = max(0, int(round((t0 - 6 / fps) * sr))), min(len(mix), int(round((t0 + 6 / fps) * sr)))
    env = 20 * np.log10(np.sqrt(uniform_filter1d((mix[a:b] ** 2).mean(1), w)) + 1e-9)
    rise = env[w:] - env[:-w]
    return round((a + int(np.argmax(rise)) + w // 2) / sr, 4)


def main():
    ap = argparse.ArgumentParser(description='程序化合成本片声音，写 48 kHz 立体声 wav')
    ap.add_argument('film', nargs='?', default=HERE, help='作品目录（默认本文件所在目录）')
    ap.add_argument('--out', help='输出 wav（默认 <作品目录>/out/mix.wav）')
    a = ap.parse_args()
    film_dir = os.path.abspath(a.film)
    mix, ctx, _ = build(film_dir)
    import numpy as np
    import soundfile as sf
    from engine.audio.meter import integrated, true_peak
    fps, n, t_sun, EV, SR, gain_db = ctx['fps'], ctx['n'], ctx['t_sun'], ctx['EV'], ctx['SR'], ctx['gain_db']

    # ── 自检：时长逐样本对齐；钟声起音与 sun-break 同帧（±1 帧）；响度与真峰值 ──
    if len(mix) != n:
        die(4, f'声音长 {len(mix)} 样本，画面要 {n}')
    on = strike(mix, t_sun, fps, SR)
    if on is None or abs(on - t_sun) > 1 / fps:
        die(4, f'钟声起音 {on} 秒，与 sun-break（第 {EV["sun-break"]["frame"]} 帧 = {t_sun:.4f} 秒）差超过 1 帧',
            '检查 bell 的摆放与事件表；不要手抄秒数')
    lufs, tp = integrated(mix), 20 * np.log10(true_peak(mix) + 1e-12)

    out = a.out or os.path.join(film_dir, 'out', 'mix.wav')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + '.part.wav'
    sf.write(tmp, mix.astype(np.float32), SR, subtype='PCM_24')
    os.replace(tmp, out)
    print(json.dumps({'path': os.path.relpath(out, ROOT).replace(os.sep, '/'), 'seconds': round(len(mix) / SR, 4),
                      'lufs': round(lufs, 2), 'truePeakDbTP': round(float(tp), 2), 'gainDb': round(float(gain_db), 2),
                      'events': {'sun-break': {'frame': EV['sun-break']['frame'], 'onset': on, 'errFrames': round((on - t_sun) * fps, 3)}}},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
