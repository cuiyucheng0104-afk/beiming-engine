# -*- coding: utf-8 -*-
"""渡 · 声音：全部程序化合成（engine/audio），同一个种子永远同一段声音；时间全部读 film.json，和画面同源。

声音剧本（TREATMENT.md §11）：
  0–24     远处江面的水声 + 雾里的远风，宽而闷
  boat-in  第 24 帧舟入画、第一桨落水：一声闷的入水（低频水团 + 一点气泡音高下滑）；之后每 16 帧一桨（24、40、56），
           声像跟着舟从左往中间走；桨声底下垫一层近处的船边拍水，舟入画才有
  oar-stop 第 60 帧停桨、桨尖滴水：一声清的水滴（音高上滑的短正弦），前 3 帧把环境压下去一点让它露出来
  settle   第 78 帧舟停稳：水声与风在 78–84 帧收掉，84 帧起真静默到片尾——静止的画面配静止的声音
对位核对：写完 wav 后在混音上测两个事件的起音（第一桨、滴水），和事件帧差超过 1 帧就失败（craft/animation.md §5.7）；
84 帧之后要真静默（RMS 低于 −60 dBFS）。事件帧是结果帧：声音同帧或稍后起音，不抢在画面前面。

用法：统一出片会自动调用（npm run film -- build films/du 的 mix 步骤，写到运行目录）。单独跑（在仓库根目录）：
  node tools/env/py.mjs films/du/sound.py [films/du] [--out <wav>]
  输出位置：--out > 环境变量 BEIMING_AUDIO_OUT（统一出片设它，指向 out/<运行号>/audio/mix.wav）> films/du/out/mix.wav。
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
    for need in ('boat-in', 'oar-stop', 'settle'):
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
        die(3, f'缺 Python 依赖：{e}', '在仓库根目录运行 npm run setup，再用 node tools/env/py.mjs 启动（或设 BEIMING_PYTHON 指向装好依赖的解释器）')

    film, fps, nf, EV, cuts = load_film(film_dir)
    # 统一出片给的规格：和作品描述不一致就是换了档位却没改 film.json（变量名写全，环境变量登记检查才认得出）
    for k, got, want in (('BEIMING_FPS', os.environ.get('BEIMING_FPS'), fps), ('BEIMING_FRAMES', os.environ.get('BEIMING_FRAMES'), nf)):
        if got and abs(float(got) - want) > 1e-9:
            die(4, f'{k}={got} 与 film.json 的 {want} 不一致', '改 film.json 的 output（或按 film.json 的档位出片），声音和画面才对得上')
    D = nf / fps                       # 时长 = 帧数 ÷ 帧率，和画面逐样本对齐
    n = N(D)
    t = T(D)
    f_in, f_stop, f_settle = (EV[k]['frame'] for k in ('boat-in', 'oar-stop', 'settle'))
    t_in, t_stop, t_settle = f_in / fps, f_stop / fps, f_settle / fps
    t_quiet = (f_settle + 6) / fps                                       # 真静默从这里开始
    ramp = smoothstep
    pan_of = lambda tt: -0.85 + 0.7 * ramp(t_in, t_settle, tt)          # 舟在画左入画、停在中间偏左

    # ── 环境：远水 + 远风，78–84 帧收掉；舟入画后加一层近处的船边拍水（跟着舟的声像） ──
    far_w, _, _ = match_level(water(D, 11, 'far'), -24.0, 'win', 0.0, D)
    air, _ = wind(D, 7, 'far')
    air, _, _ = match_level(air, -28.0, 'win', 0.0, D)
    hull, _, _ = match_level(stereo(water(D, 17, 'hull').mean(1), pan_of(t_stop)), -30.0, 'win', 0.0, D)
    hull = hull * (ramp(t_in, t_in + 0.4, t) * (1 - ramp(t_stop, t_settle, t)))[:, None]
    out_env = 1 - ramp(t_settle, t_quiet, t)
    duck = 1 - 0.5 * ramp(t_stop - 3 / fps, t_stop, t) * (1 - ramp(t_stop + 0.1, t_stop + 0.5, t))   # 滴水前压一点，让它露出来
    bed = (far_w + air + hull) * (out_env * duck)[:, None]

    # ── 桨入水：低频水团（带通噪声，快起慢落）+ 一点气泡音高下滑；起音就在桨落水的那一帧 ──
    def plop(seed):
        d = 0.35; tt = T(d); rr = rng(seed)
        body = bp(white(N(d), rr), 180, 1100, 2) * ramp(0, 0.004, tt) * np.exp(-tt / 0.07)
        f = 700 * np.exp(-tt / 0.05) + 260
        bub = np.sin(2 * np.pi * np.cumsum(f) / SR) * ramp(0, 0.003, tt) * np.exp(-tt / 0.04) * 0.5
        return body / (np.abs(body).max() + 1e-12) + bub
    oars = np.zeros((n, 2))
    for i, f in enumerate(range(f_in, f_stop, 16)):                      # scene.mjs：每 16 帧一桨，桨在 24、40、56 帧落水
        place(oars, plop(31 + i), f / fps, 1.0, pan_of(f / fps))
    oars = reverb(oars, make_ir(rt=0.9, pre=0.01, seed=5, length=1.0), wet=0.25, dry=1.0)
    oars, _, _ = match_level(oars, -18.0, 'mom', t_in, t_in + 0.4)

    # ── 桨尖滴水：音高上滑的短正弦（水滴落水的「叮」），偏左 ──
    dd = 0.18; tt = T(dd)
    drop = np.sin(2 * np.pi * np.cumsum(1300 + 1400 * ramp(0, 0.05, tt)) / SR) * ramp(0, 0.002, tt) * np.exp(-tt / 0.035)
    drips = np.zeros((n, 2))
    place(drips, drop, t_stop, 1.0, pan_of(t_stop))
    drips = reverb(drips, make_ir(rt=1.2, pre=0.01, seed=9, length=1.2), wet=0.3, dry=1.0)
    drips, _, _ = match_level(drips, -21.0, 'mom', t_stop, t_stop + 0.25)

    stems = {'bed': bed, 'oar': oars, 'drip': drips}
    mix = fade(sum(stems.values()), 0.25, 0.0) * (t < t_quiet)[:, None]  # 混响尾巴也在真静默前截掉
    mix, gain_db, _ = loudness_to(mix, -14.0, -1.5)
    ctx = {'fps': fps, 'n': n, 'EV': EV, 'gain_db': float(gain_db), 'SR': SR, 't_quiet': t_quiet}
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
    ap = argparse.ArgumentParser(description='程序化合成本片声音，写 48 kHz 立体声 wav')
    ap.add_argument('film', nargs='?', default=HERE, help='作品目录（默认本文件所在目录）')
    ap.add_argument('--out', help='输出 wav（默认 <作品目录>/out/mix.wav）')
    a = ap.parse_args()
    film_dir = os.path.abspath(a.film)
    mix, ctx, _ = build(film_dir)
    import numpy as np
    import soundfile as sf
    from engine.audio.meter import integrated, true_peak
    fps, n, EV, SR, gain_db = ctx['fps'], ctx['n'], ctx['EV'], ctx['SR'], ctx['gain_db']

    # ── 自检：时长逐样本对齐；钟声、落笔声的起音与各自的事件同帧（声音不早于画面，晚不超过 1 帧）；响度与真峰值 ──
    if len(mix) != n:
        die(4, f'声音长 {len(mix)} 样本，画面要 {n}')
    onsets = {}
    gap = 16                           # 相邻两桨隔 16 帧：只在事件 ±8 帧内找起音
    for eid, what in (('boat-in', '第一桨'), ('oar-stop', '滴水声')):
        t0 = EV[eid]['frame'] / fps
        on = strike(mix, t0, fps, SR, half=max(1, min(6, gap // 2)))
        if on is None or on < t0 - 0.25 / fps or on > t0 + 1 / fps:
            die(4, f'{what}起音 {on} 秒，与 {eid}（第 {EV[eid]["frame"]} 帧 = {t0:.4f} 秒）对不上（要同帧或晚不超过 1 帧）',
                f'检查 {what}的摆放与事件表；不要手抄秒数')
        onsets[eid] = {'frame': EV[eid]['frame'], 'onset': on, 'errFrames': round((on - t0) * fps, 3)}
    q = mix[int(round(ctx['t_quiet'] * SR)):]
    quiet_db = 20 * np.log10(np.sqrt((q ** 2).mean()) + 1e-12) if len(q) else -999.0
    if quiet_db > -60:
        die(4, f'第 {round(ctx["t_quiet"] * fps)} 帧起应是真静默，实测 RMS {quiet_db:.1f} dBFS', '检查环境与混响尾巴的截断')
    lufs, tp = integrated(mix), 20 * np.log10(true_peak(mix) + 1e-12)

    out = a.out or os.environ.get('BEIMING_AUDIO_OUT') or os.path.join(film_dir, 'out', 'mix.wav')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    # 起音登记（标签 = 事件的 audio 字段）：cuecheck 默认读 <作品>/out/score_onsets.json，出片链里另在混音旁边放一份
    from engine.audio.cues import Onsets
    on = Onsets()
    for eid in onsets:
        on.mark(onsets[eid]['onset'], EV[eid]['audio'])
    for d in {os.path.join(film_dir, 'out'), os.path.dirname(os.path.abspath(out))}:
        on.dump(os.path.join(d, 'score_onsets.json'))
    tmp = out + '.part.wav'
    sf.write(tmp, mix.astype(np.float32), SR, subtype='PCM_24')
    os.replace(tmp, out)
    try:
        shown = os.path.relpath(out, ROOT).replace(os.sep, '/')
    except ValueError:                 # Windows 上跨盘符
        shown = os.path.basename(out)
    print(json.dumps({'path': shown if not shown.startswith('..') else os.path.basename(out), 'seconds': round(len(mix) / SR, 4),
                      'lufs': round(lufs, 2), 'truePeakDbTP': round(float(tp), 2), 'gainDb': round(float(gain_db), 2),
                      'events': onsets},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
