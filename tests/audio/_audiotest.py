# -*- coding: utf-8 -*-
"""tests/audio 的共用件：合成测试信号、写作品描述、搭只含声音链路的临时仓库树、跑命令。

不是测试文件（不以 test_ 开头），由同目录的测试 import。所有产物都写进系统临时目录，测试结束删掉，不碰仓库里的任何文件。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from engine.audio.dsp import SR, N, pink, lp, hp, fade, rng  # noqa: E402
from engine.audio.mixing import loudness_to  # noqa: E402

SKIP = shutil.ignore_patterns('stems', 'check', 'samples', '__pycache__', 'test_*.py', 'out')


def env(**extra):
    e = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1')
    e['PYTHONPATH'] = os.pathsep.join([ROOT] + [p for p in os.environ.get('PYTHONPATH', '').split(os.pathsep) if p])
    e.setdefault('NUMBA_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'beiming-numba-cache'))
    e.update(extra)
    return e


def run(args, cwd=ROOT, timeout=900, **extra):
    """跑一条命令（args[0] 是 'python' 时换成当前解释器）→ CompletedProcess（文本，UTF-8）"""
    if args and args[0] == 'python':
        args = [sys.executable] + list(args[1:])
    return subprocess.run(args, cwd=cwd, env=env(**extra), capture_output=True, encoding='utf-8', errors='replace', timeout=timeout)


def envelope(r):
    """--json 的 stdout → 信封 dict（不是单个 JSON 对象时抛 AssertionError，带上输出）"""
    try:
        d = json.loads(r.stdout)
    except ValueError:
        raise AssertionError(f'stdout 不是一个 JSON 对象：\n{r.stdout[-1500:]}\nstderr：\n{r.stderr[-1500:]}') from None
    assert isinstance(d, dict) and d.get('schemaVersion') == 1, d
    return d


def music_like(seconds, seed=1, corr=0.6, lp_hz=9000):
    """像音乐的宽带信号：粉噪声过 60 Hz 高通 / lp_hz 低通（默认 9 kHz；1.5 kHz 像柔和的铺底），左右部分相关，慢速起伏；首尾 20 ms 淡入淡出"""
    r = rng(seed)
    n = N(seconds)
    a, b = pink(n, r), pink(n, r)
    left, right = a, corr * a + np.sqrt(1 - corr ** 2) * b
    x = np.stack([left, right], 1)
    x = lp(hp(x, 60, 2), lp_hz, 2)
    t = np.arange(n) / SR
    x *= (0.75 + 0.25 * np.sin(2 * np.pi * 0.37 * t))[:, None]
    return fade(x, 0.02, 0.02)


def mastered(seconds, lufs=-14.0, tp=-1.5, seed=1, corr=0.6, lp_hz=9000):
    """母带到 lufs / tp（engine.audio.mixing.loudness_to：总增益 + 前视真峰值限制），最后一个样本置 0"""
    x, _, _ = loudness_to(music_like(seconds, seed, corr, lp_hz), lufs, tp)
    x[0] = 0.0
    x[-1] = 0.0
    return x


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def write_wav(path, x, subtype='PCM_24'):
    import soundfile as sf
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    sf.write(path, x, SR, subtype=subtype)
    return path


def film_json(d, frames=240, fps=24, cuts=(120,), profile='web-1080p24', size=(1920, 1080), audio=None, events=None, **extra):
    """在目录 d 写一份最小的 film.json v2（C6 的必填字段 + 镜头表）→ 路径"""
    edges = [0, *cuts, frames]
    shots = [{'id': f'S{i + 1}', 'in': a, 'out': b, 'module': f'shots/s{i + 1}.js'} for i, (a, b) in enumerate(zip(edges, edges[1:]))]
    doc = {'schemaVersion': 2, 'id': os.path.basename(os.path.abspath(d)), 'title': '测试', 'route': 'a', 'backend': 'three',
           'output': {'profile': profile, 'width': size[0], 'height': size[1], 'fps': fps, 'frameCount': frames},
           'shots': shots, 'events': events or [],
           'audio': audio if audio is not None else {'mode': 'script', 'script': 'sound.py', 'targetLUFS': -14, 'truePeakDbTP': -1.0}}
    doc.update(extra)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, 'film.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    return p


def sound_tree(dst):
    """临时仓库树：audio/（不含分轨、自检、采样、测试）、engine/audio、engine/render/mux.sh 与它转交的 engine/render/lib/mux.mjs
    （P04 渲染器 v2；连同它 import 的 tools/compliance/lib）、tools/lib（命令约定库）、tools/env（audio/build.sh 经
    node tools/env/py.mjs 调用）、tools/audio（Node 入口）。在它里面跑《北冥》声音构建，不碰真实仓库的 out/ 与 audio/check/"""
    shutil.copytree(os.path.join(ROOT, 'audio'), os.path.join(dst, 'audio'), ignore=SKIP)
    os.makedirs(os.path.join(dst, 'engine', 'render'), exist_ok=True)
    shutil.copytree(os.path.join(ROOT, 'engine', 'audio'), os.path.join(dst, 'engine', 'audio'), ignore=SKIP)
    shutil.copy(os.path.join(ROOT, 'engine', 'render', 'mux.sh'), os.path.join(dst, 'engine', 'render'))
    # 目录清单同 tests/render/helpers.mjs 的 RENDERER_DIRS（tools/env/lib 随 tools/env 整拷）
    for d in (('engine', 'render', 'lib'), ('tools', 'compliance', 'lib'), ('tools', 'lib'), ('tools', 'env'), ('tools', 'audio')):
        shutil.copytree(os.path.join(ROOT, *d), os.path.join(dst, *d), ignore=SKIP)
    with open(os.path.join(dst, 'package.json'), 'w', encoding='utf-8') as f:
        f.write('{"name": "beiming-sound-tree", "private": true, "type": "module"}\n')
    return dst


def tmpdir(prefix):
    return tempfile.mkdtemp(prefix=f'beiming-{prefix}-')


def which_ffmpeg():
    from engine.audio import _env
    return shutil.which(_env.ffmpeg()) and shutil.which(_env.ffprobe())
