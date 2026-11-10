# -*- coding: utf-8 -*-
"""长片混音的内存探针：用 engine/audio/stream 合成一条 N 秒（默认 600 秒）的完整混音——三层分段生成的环境声底层、
上千个一次性音效、一条"旁白"层（带让路包络）——母带到 −14 LUFS / −1 dBTP，写 PCM_24，最后打印一行 JSON：
{seconds, peakRssMb, wallSec, integrated, truePeakDb, events}。tests/audio/test_stream.py 用它断言峰值内存 < 1.5 GB。

用法：python tests/audio/longmix_probe.py <输出目录> [秒数]
写法就是长片的推荐写法：一次只留一条工作总线和一条母带总线在内存里，分轨处理完就写盘、释放。
"""
import json
import os
import sys
import time
import tracemalloc

T0 = time.time()
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)

import numpy as np  # noqa: E402

from engine.audio import ambience as A, stream as S  # noqa: E402
from engine.audio.dsp import N, SR, T, rng, lp, hp, fade, smoothstep  # noqa: E402
from engine.audio.synth import glass_tone  # noqa: E402


def peak_rss_mb():
    try:
        import resource
        r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return r / (1 << 20) if sys.platform == 'darwin' else r / 1024      # macOS 是字节，Linux 是 KiB
    except ImportError:
        pass
    try:
        import psutil
        mi = psutil.Process().memory_info()
        return getattr(mi, 'peak_wset', mi.rss) / (1 << 20)
    except ImportError:
        return tracemalloc.get_traced_memory()[1] / (1 << 20)               # 只计 Python / numpy 分配，作近似


def main(out, dur):
    try:
        import resource  # noqa: F401  POSIX：直接读进程峰值，不需要 tracemalloc
    except ImportError:
        tracemalloc.start()
    n = N(dur)
    master = S.Bus(n, 'master')
    r = rng(7)

    # 1) 环境声：三层，各自 20 秒一段、交叉 1 秒（同一时刻只有一段在内存里）
    amb = S.Bus(n, 'amb')
    S.bed(amb, lambda d, s: A.wind(d, s, 'far')[0] * 0.5, 0, dur, seg=20, xf=1.0, seed=100)
    S.bed(amb, lambda d, s: A.water(d, s, 'far') * 0.3, 0, dur, seg=20, xf=1.0, seed=200)
    S.bed(amb, lambda d, s: A.city_hum(d, s, fog=1.4) * 0.4, 0, dur, seg=20, xf=1.0, seed=300)
    S.write_wav(os.path.join(out, 'amb.wav'), amb.buf, subtype='FLOAT')
    master.mix(amb, 0.1)
    del amb

    # 2) 音效：每 0.6 秒左右一个玻璃音或点击，声像随机
    fx = S.Bus(n, 'fx')
    t, k = 0.3, 0
    while t < dur - 2:
        if r.uniform() < 0.5:
            x = glass_tone(r.uniform(600, 1800), d=1.2, decay=0.3) * 0.3
        else:
            m = N(0.08)
            x = hp(r.standard_normal(m), 900, 2) * np.exp(-T(0.08) / 0.01) * 0.4
        fx.place(x, t, 1.0, float(r.uniform(-0.8, 0.8)))
        t += float(r.uniform(0.3, 0.9))
        k += 1
    S.write_wav(os.path.join(out, 'fx.wav'), fx.buf, subtype='FLOAT')
    master.mix(fx, 0.5)
    del fx

    # 3) "旁白"：每 8 秒一句 3–5 秒的共振峰嗡声；母带前给其他层让路（让路曲线按块算，不分配全长数组）
    vo = S.Bus(n, 'vo')
    lines = []
    t = 2.0
    while t < dur - 6:
        d = float(r.uniform(3, 5))
        tt = T(d)
        f0 = 140 * (1 + 0.08 * np.sin(2 * np.pi * 3.1 * tt))
        x = sum(np.sin(2 * np.pi * f0 * h * tt) / h for h in range(1, 9))
        x = lp(x, 3000, 2) * np.sin(np.pi * tt / d) ** 0.4 * 0.2
        vo.place(fade(x, 0.02, 0.05), t)
        lines.append((t, t + d))
        t += 8.0
    starts = np.array([a for a, _ in lines])
    ends = np.array([b for _, b in lines])

    def duck(ts):
        i = np.clip(np.searchsorted(starts, ts, 'right') - 1, 0, len(starts) - 1)
        on = smoothstep(starts[i] - 0.15, starts[i], ts) * (1 - smoothstep(ends[i], ends[i] + 0.4, ts))
        return 1 - 0.5 * on
    master.shape(duck)
    S.write_wav(os.path.join(out, 'vo.wav'), vo.buf, subtype='FLOAT')
    master.mix(vo, 1.0)
    del vo

    # 4) 母带：−14 LUFS、真峰值 −1 dBTP（分块），写 PCM_24
    g, st = S.loudness_to(master.buf, -14.0, -1.0)
    path = S.write_wav(os.path.join(out, 'mix.wav'), master.buf)
    m = S.measure(path)
    return {'seconds': dur, 'peakRssMb': round(peak_rss_mb(), 1), 'wallSec': round(time.time() - T0, 1),
            'integrated': round(m['integrated'], 3), 'truePeakDb': round(m['truePeakDb'], 3), 'events': k, 'lines': len(lines),
            'masterGainDb': round(g, 2), 'limiter': st}


if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    print(json.dumps(main(out, float(sys.argv[2]) if len(sys.argv) > 2 else 600.0), ensure_ascii=False))
