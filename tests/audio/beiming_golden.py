# -*- coding: utf-8 -*-
"""《北冥》混音金标准：按平台记录默认构建（配乐读定稿缓存）的 out/mix.wav 与五条分轨的 sha256，外加一份容差指纹。

  python tests/audio/beiming_golden.py record [--from <已构建的树>]   在临时树里跑一遍默认构建（或读已构建的树），写 tests/audio/golden/<平台>.json
  python tests/audio/beiming_golden.py compare [--from <已构建的树>]  与本平台的记录比对；退出码 0 一致 / 4 不一致 / 3 本平台没有记录

每个文件记三样：sha256（文件字节）、samplesSha256（样本按 float32 小端的字节，24 bit 与 32 位浮点都能无损表示）、指纹。
32 位浮点 WAV（分轨）的文件头里有 libsndfile 写的 PEAK 块，带写盘时刻，文件字节每次都不同，所以分轨只比样本；
24 bit 的 out/mix.wav 没有这个块，文件字节也要相同（它就是交给封装的那个文件）。
判定（test_audio_beiming.py 用同一套函数）：
  · 同平台、同一组依赖版本（Python、numpy、scipy、numba、llvmlite、soundfile、libsndfile、soxr）：样本必须逐个相同，整数 PCM 的文件逐字节相同；
  · 同平台、依赖版本不同：sha256 可以不同（浮点库的最后一位），但指纹（每 0.25 秒每声道的均方根与峰值）差不能超过 2e-6，
    比 24 bit 量化的一个最低位（1.2e-7）大一个数量级，比任何听得出的改动（0.01 dB 约 1e-4 的相对变化）小两个数量级；
  · 本平台没有记录：不判（测试跳过并提示怎么记录）。
平台键与 Node 的 `${process.platform}-${process.arch}` 相同：darwin-arm64、linux-x64、win32-x64……
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
GOLDEN_DIR = os.path.join(HERE, 'golden')
FILES = ['out/mix.wav'] + [f'audio/stems/{k}.wav' for k in ('amb', 'fx', 'kun', 'ui', 'music')]
BLOCK_S = 0.25
TOL = 2e-6
SCHEMA = 'beiming.audio-golden/1'


def platform_key():
    plat = {'darwin': 'darwin', 'win32': 'win32', 'cygwin': 'win32'}.get(sys.platform, 'linux' if sys.platform.startswith('linux') else sys.platform)
    m = platform.machine().lower()
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(m, m)
    return f'{plat}-{arch}'


def env_versions():
    out = {'python': platform.python_version()}
    for mod in ('numpy', 'scipy', 'numba', 'llvmlite', 'soundfile', 'soxr'):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:  # 没装就记 None
            out[mod] = None
    try:
        import soundfile
        out['libsndfile'] = soundfile.__libsndfile_version__
    except Exception:
        out['libsndfile'] = None
    return out


def _sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def fingerprint(path):
    """每 0.25 秒、每个声道的均方根与峰值（9 位小数）"""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, dtype='float64', always_2d=True)
    hop = int(round(sr * BLOCK_S))
    rms, peak = [], []
    for a in range(0, len(x), hop):
        seg = x[a:a + hop]
        rms.append([round(float(v), 9) for v in np.sqrt(np.mean(seg ** 2, axis=0))])
        peak.append([round(float(v), 9) for v in np.abs(seg).max(axis=0)])
    return {'samples': len(x), 'channels': x.shape[1], 'subtype': sf.info(path).subtype, 'rms': rms, 'peak': peak}


def samples_sha256(path):
    import numpy as np
    import soundfile as sf
    x, _ = sf.read(path, dtype='float32', always_2d=True)
    return hashlib.sha256(np.ascontiguousarray(x, dtype='<f4').tobytes()).hexdigest()


def measure(tree):
    """已构建的树 → {文件: {sha256, samplesSha256, fingerprint}}"""
    out = {}
    for rel in FILES:
        p = os.path.join(tree, *rel.split('/'))
        if not os.path.exists(p):
            raise FileNotFoundError(f'{rel} 不在 {tree} 里：先跑默认构建（python audio/build.py）')
        out[rel] = {'sha256': _sha(p), 'samplesSha256': samples_sha256(p), 'fingerprint': fingerprint(p)}
    return out


def _same(c, g):
    """样本相同；整数 PCM 另要求文件字节相同（浮点 WAV 的 PEAK 块带时刻，不比文件字节）"""
    if c['samplesSha256'] != g['samplesSha256']:
        return False
    return c['fingerprint']['subtype'] not in ('PCM_16', 'PCM_24', 'PCM_32') or c['sha256'] == g['sha256']


def load(key=None):
    p = os.path.join(GOLDEN_DIR, f'{key or platform_key()}.json')
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def _maxdiff(a, b):
    if a['samples'] != b['samples'] or a['channels'] != b['channels'] or len(a['rms']) != len(b['rms']):
        return float('inf')
    d = 0.0
    for k in ('rms', 'peak'):
        for ra, rb in zip(a[k], b[k]):
            d = max(d, max(abs(x - y) for x, y in zip(ra, rb)))
    return d


def compare(cur, gold, env=None):
    """→ (ok, mode, 说明行)。mode：exact（逐字节）/ tolerance（依赖版本不同，按指纹容差）"""
    env = env or env_versions()
    same_env = any(all(e.get(k) == env.get(k) for k in env) for e in gold.get('envs', []))
    lines, ok = [], True
    for rel, g in gold['files'].items():
        c = cur.get(rel)
        if c is None:
            ok = False
            lines.append(f'{rel}：这次构建没有它')
            continue
        if _same(c, g):
            continue
        if same_env:
            ok = False
            lines.append(f'{rel}：样本摘要 {c["samplesSha256"][:12]}… / 文件 {c["sha256"][:12]}… 与记录 {g["samplesSha256"][:12]}… / '
                         f'{g["sha256"][:12]}… 不同（同平台、同一组依赖版本，必须逐样本一致）')
            continue
        d = _maxdiff(c['fingerprint'], g['fingerprint'])
        if d > TOL:
            ok = False
            lines.append(f'{rel}：指纹最大差 {d:.3g}，超过容差 {TOL}（依赖版本与记录不同，但差得太多，不是浮点最后一位的差别）')
        else:
            lines.append(f'{rel}：sha256 不同但指纹差 {d:.2g} ≤ {TOL}（依赖版本与记录不同，按容差通过）')
    return ok, 'exact' if same_env else 'tolerance', lines


def _build(tree):
    import tempfile
    sys.path.insert(0, HERE)
    import _audiotest as H
    if tree:
        return tree, None
    td = tempfile.mkdtemp(prefix='beiming-golden-')
    H.sound_tree(td)
    r = H.run(['python', 'audio/build.py', '--quiet'], cwd=td)
    if r.returncode != 0:
        raise SystemExit(f'默认构建没通过（退出码 {r.returncode}）：\n{r.stderr[-2000:]}')
    return td, td


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog='python tests/audio/beiming_golden.py', description='《北冥》混音金标准：记录或比对（见文件头）')
    ap.add_argument('action', choices=['record', 'compare'])
    ap.add_argument('--from', dest='tree', help='已构建好的树（里面有 out/mix.wav 与 audio/stems/）；不给就在临时目录里构建一遍')
    a = ap.parse_args(argv)
    import shutil
    tree, cleanup = _build(a.tree)
    try:
        cur = measure(tree)
    finally:
        if cleanup:
            shutil.rmtree(cleanup, ignore_errors=True)
    key, env = platform_key(), env_versions()
    gold = load(key)
    if a.action == 'compare':
        if gold is None:
            print(f'没有 {key} 的记录：python tests/audio/beiming_golden.py record', file=sys.stderr)
            return 3
        ok, mode, lines = compare(cur, gold, env)
        print(f'{key}：{"一致" if ok else "不一致"}（{"逐字节" if mode == "exact" else "依赖版本不同，按指纹容差"}）')
        for ln in lines:
            print('  ' + ln)
        return 0 if ok else 4
    if gold is not None and any(not _same(cur[r], g) for r, g in gold['files'].items()):
        ok, mode, lines = compare(cur, gold, env)
        if not ok:
            print('这次构建与已有记录不一致，不覆盖：\n  ' + '\n  '.join(lines) + '\n确认是有意改动时先删掉 ' +
                  os.path.relpath(os.path.join(GOLDEN_DIR, f'{key}.json'), ROOT) + ' 再记录', file=sys.stderr)
            return 4
    envs = (gold or {}).get('envs', [])
    if env not in envs:
        envs.append(env)
    doc = {'schema': SCHEMA, 'platformKey': key,
           '说明': '《北冥》默认构建（node tools/audio/build.mjs，即 python audio/build.py；配乐读定稿缓存）的混音与分轨。'
                 'envs 列出实测得到同一组 sha256 的依赖版本；判定规则见 tests/audio/beiming_golden.py。',
           'envs': envs, 'files': {r: v for r, v in cur.items()},
           'recordedAt': (gold or {}).get('recordedAt') or datetime.date.today().isoformat(),
           'updatedAt': datetime.date.today().isoformat()}
    os.makedirs(GOLDEN_DIR, exist_ok=True)
    p = os.path.join(GOLDEN_DIR, f'{key}.json')
    text = json.dumps(doc, ensure_ascii=False, indent=1)
    text = re.sub(r'\[\n\s+(-?[0-9.e+-]+),\n\s+(-?[0-9.e+-]+)\n\s+\]', r'[\1, \2]', text)    # 每块的左右声道写一行
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')
    print(f'写了 {os.path.relpath(p, ROOT)}：mix.wav {cur["out/mix.wav"]["sha256"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
