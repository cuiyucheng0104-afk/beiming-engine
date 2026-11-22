# -*- coding: utf-8 -*-
"""python -m engine.audio.erb：从一段录音渲染 N 个新 take（试听、出素材用），有 GPU 就整批上 GPU。

用法：python -m engine.audio.erb in.wav --out takes/ --n 8 [--vary 1] [--exact 8] [--seed 0] [--device auto|gpu|cpu] [--json]
输出：<out>/take_01.wav … （48 kHz、24 bit）。第 k 下用种子 seed + k，同一台设备上重跑结果相同。
退出码：0 成功、2 用法错误、3 缺依赖（输入文件不存在、指定 --device gpu 但没有可用的 nvcc 与 GPU）。
"""
import math
import os
import sys
import time

import numpy as np

from .._cli import ArgumentParser, CliError, rel, run as run_cli, sha256_file
from . import core, gpu, render_many

MAX_SECONDS = 60.0  # 模型比原 WAV 大约 24 倍，这是做音效的，不是做长片的


def make_parser():
    p = ArgumentParser(prog='python -m engine.audio.erb',
                       description='从一段录音渲染 N 个新 take（96 带 ERB 再合成）：退出码 0 成功、2 用法错误、3 缺依赖')
    p.add_argument('input', help=f'输入录音（soundfile 能读的格式，单声道或立体声，不超过 {MAX_SECONDS:.0f} 秒；不是 48 kHz 会先重采样）')
    p.add_argument('--out', required=True, help='输出目录（写 take_01.wav …，48 kHz、24 bit）')
    p.add_argument('--n', type=int, default=8, help='渲染几下（默认 8）')
    p.add_argument('--seed', type=int, default=0, help='第 k 下用种子 seed + k（默认 0）')
    p.add_argument('--vary', type=float, default=1.0, help='take 之间的变化强度：0 = 同一下的干净再合成，1 = 同一件东西连敲的典型差异（默认 1）')
    p.add_argument('--exact', type=int, default=8, help='交替投影轮数，越多越贴合模型也越慢（默认 8）')
    p.add_argument('--dur', type=float, default=1.0, help='时长倍率（默认 1）；起音段保持原速')
    p.add_argument('--size', type=float, default=1.0, help='物理尺寸倍率（>1 更大更低沉，默认 1）')
    p.add_argument('--pitch', type=float, default=0.0, help='音高微调（半音，默认 0）')
    p.add_argument('--bright', type=float, default=0.0, help='频谱倾斜（dB/八度，以 1.5 kHz 为支点，默认 0）')
    p.add_argument('--device', choices=('auto', 'gpu', 'cpu'), default='auto', help='auto = 有 nvcc 与 GPU 就用 GPU，否则 CPU（默认）')
    return p


def _load(path):
    import soundfile as sf
    try:
        x, sr = sf.read(path, dtype='float32', always_2d=True)
    except (RuntimeError, OSError) as e:
        raise CliError('usage.unreadable-input', f'读不了输入录音 {path}：{e}', 'soundfile 能读的格式（wav、flac、ogg……）') from e
    if x.shape[1] > 2:
        raise CliError('usage.channels', f'输入有 {x.shape[1]} 个声道，只支持单声道或立体声')
    if sr != core.SR:
        from scipy.signal import resample_poly
        g = math.gcd(core.SR, int(sr))
        x = resample_poly(x, core.SR // g, int(sr) // g, axis=0).astype(np.float32)
    if len(x) > MAX_SECONDS * core.SR:
        raise CliError('usage.too-long', f'输入 {len(x) / core.SR:.1f} 秒，超过 {MAX_SECONDS:.0f} 秒', '先剪出一下要再合成的那一段')
    if len(x) < core.SR // 100:
        raise CliError('usage.too-short', f'输入只有 {len(x)} 个采样点（不到 10 ms）')
    return x[:, 0] if x.shape[1] == 1 else x


def main_cli(args, ctx):
    if not 1 <= args.n <= 1024:
        raise CliError('usage.bad-value', f'--n 要在 1 到 1024 之间，收到 {args.n}')
    if args.exact < 0 or args.vary < 0:
        raise CliError('usage.bad-value', '--exact 与 --vary 不能为负')
    if args.dur <= 0 or args.size <= 0:
        raise CliError('usage.bad-value', '--dur 与 --size 要正数')
    if not os.path.isfile(args.input):
        raise CliError('env.input-missing', f'输入录音不存在：{args.input}')
    try:
        use_gpu = args.device != 'cpu' and gpu.available()
    except gpu.GpuError as e:
        raise CliError('env.gpu-failed', f'GPU 初始化失败：{e}', '加 --device cpu 可以绕开 GPU 先出结果，同时把这条报错带去排查') from e
    if args.device == 'gpu' and not use_gpu:
        raise CliError('env.no-gpu', '没有可用的 nvcc 与 GPU', '装 CUDA Toolkit（或设 BEIMING_NVCC 指向 nvcc），或改用 --device cpu')

    import soundfile as sf
    x = _load(args.input)
    t0 = time.perf_counter()
    model = core.analyze(x)
    t1 = time.perf_counter()
    kw = dict(vary=args.vary, exact=args.exact, dur=args.dur, size=args.size, pitch=args.pitch, bright=args.bright)
    jobs = [(model, dict(kw, seed=args.seed + k)) for k in range(args.n)]
    try:
        ys = render_many(jobs, device='gpu' if use_gpu else 'cpu')
    except gpu.GpuOutOfMemory as e:
        if args.device == 'gpu':
            raise CliError('env.gpu-memory', f'显存不够：{e}', '改用 --device cpu，或剪短输入、减小 --dur') from e
        ctx.log('显存不够，退回 CPU')
        use_gpu = False
        ys = render_many(jobs, device='cpu')
    except gpu.GpuError as e:
        raise CliError('env.gpu-failed', f'GPU 渲染失败：{e}', '加 --device cpu 可以绕开 GPU 先出结果，同时把这条报错带去排查') from e
    t2 = time.perf_counter()

    os.makedirs(args.out, exist_ok=True)
    outputs = []
    width = max(2, len(str(len(ys))))
    for k, y in enumerate(ys, start=1):
        path = os.path.abspath(os.path.join(args.out, f'take_{k:0{width}d}.wav'))
        sf.write(path, y, core.SR, subtype='PCM_24')
        outputs.append({'path': rel(path), 'sha256': sha256_file(path), 'kind': 'wav'})
    device = 'gpu' if use_gpu else 'cpu'
    ctx.out(f'{len(ys)} 下 → {rel(os.path.abspath(args.out))}（{device}：分析 {1e3 * (t1 - t0):.0f} ms，渲染 {1e3 * (t2 - t1):.0f} ms）')
    return {'data': {'device': device, 'n': len(ys), 'seconds': round(len(x) / core.SR, 3), 'stereo': bool(model.stereo),
                     'onsets': 0 if model.onsets is None else int(len(model.onsets)),
                     'analyzeMs': round(1e3 * (t1 - t0), 1), 'renderMs': round(1e3 * (t2 - t1), 1)},
            'outputs': outputs}


def main(argv=None):
    return run_cli(main_cli, make_parser(), argv=argv, command='audio:erb')


if __name__ == '__main__':
    sys.exit(main())
