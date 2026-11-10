# -*- coding: utf-8 -*-
"""北冥引擎 · 配乐缓存与输入键：把采样配乐的渲染结果和"它是用哪些输入渲出来的"绑在一起，输入变了就拒绝静默沿用旧配乐。

缓存是一对文件：<名>.npz（mus 立体声 float32、harmony、used）+ <名>.lock.json（输入键）。lock 的字段：
  cache    {file, sha256（npz 文件字节）, musSha256（mus 的 float32 字节，与 zip 容器无关）, samples, sampleRate}
  frozen   true = 冻结的定稿配乐：只要求登记时的乐谱源码（freeze.code）与时长不变，引擎代码、采样库变了照用
           （它本来就不能再由当前代码逐样本重渲，见 note）；false = 普通缓存：inputs 里任何一项变了都拒绝
  freeze   {date, code: {相对路径: sha256}, dur, reason}           （frozen 时）
  inputs   {code: {相对路径: sha256}, dur, seed, samplesManifest, samplesLibrary}   （--score 渲染时写入）
  renderedWith  {python, numpy, scipy, soxr, soundfile, platform}  只作记录，不参与判定
源码哈希按 LF 换行计算（Windows 的 CRLF 检出得到同一个值）。

接口：
  file_sha256(path, text=False) / digest(obj)            文件 / 稳定 JSON 的 sha256
  code_hashes(root, paths) → {相对路径: sha256}
  manifest_digest(instruments, manifest=None) → sha256 或 None    engine/audio/samples.json 里这些乐器的条目（库的固定提交 + 文件表）
  scan_library(root, instruments, manifest=None) → {ok, digest, files, problems}
                                       --score 前核对 BEIMING_SAMPLES：缺文件、多文件、字节数或哈希不符都列进 problems
  inputs(root, code, dur, seed, instruments=None, library=None) → dict   当前输入
  save(npz, lock, mus, harmony, used, inputs, note=None) → lock dict     写缓存与 lock（frozen = false）
  load(npz, lock, n_expected, current_fn, accept_stale=False) → (mus, harmony, used, info)
       current_fn(used) → 当前输入（used 是缓存里登记的乐器表，用来算采样清单摘要）
       info = {status: match | frozen | stale-accepted, changed: [...], message}；不匹配且没有 accept_stale 时抛 StaleCache
       缓存文件本身被换掉、或样本数与片长不符时，accept_stale 也不放行
  StaleCache(message, hint, changed)   .exit_code = 4（附录 C1：契约不通过）
"""
import hashlib
import json
import os
import platform

import numpy as np

SCHEMA = 'beiming.score-cache/1'
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, 'samples.json')
AUDIO_EXT = ('.flac', '.wav')


class StaleCache(Exception):
    exit_code = 4

    def __init__(self, message, hint, changed=()):
        super().__init__(message)
        self.message, self.hint, self.changed = message, hint, list(changed)


def file_sha256(path, text=False):
    with open(path, 'rb') as f:
        b = f.read()
    if text:
        b = b.replace(b'\r\n', b'\n')
    return hashlib.sha256(b).hexdigest()


def digest(obj):
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()


def code_hashes(root, paths):
    return {p: file_sha256(os.path.join(root, *p.split('/')), text=True) for p in sorted(paths)}


def _manifest(manifest=None):
    if isinstance(manifest, dict):
        return manifest
    with open(manifest or MANIFEST, encoding='utf-8') as f:
        return json.load(f)


def manifest_digest(instruments, manifest=None):
    """清单里这些乐器的条目（库 id、固定提交、目录、逐文件 path / bytes / gitBlobSha1）的摘要；清单里没有的乐器记成 null"""
    if not instruments:
        return None
    m = _manifest(manifest)
    libs = {lb['id']: lb for lb in m['libraries']}
    rows = {}
    for name in sorted(instruments):
        it = m['instruments'].get(name)
        if it is None:
            rows[name] = None
            continue
        lb = libs[it['library']]
        rows[name] = {'library': lb['id'], 'commit': lb['commit'], 'dir': it['dir'],
                      'files': [[f['path'], f['bytes'], f['gitBlobSha1']] for f in it['files']]}
    return digest(rows)


def _git_blob_sha1(b):
    return hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()


def scan_library(root, instruments, manifest=None):
    """按 engine/audio/samples.json 逐个核对 root 下这些乐器目录里的采样文件。
    返回 {ok, digest（实际文件 (相对路径, 字节数, sha256) 表的摘要）, files: 实际文件数, problems: [说明…], recorded: {相对路径: sha256}}"""
    m = _manifest(manifest)
    libs = {lb['id']: lb for lb in m['libraries']}
    problems, rows, recorded = [], [], {}
    if not root or not os.path.isdir(root):
        return {'ok': False, 'digest': None, 'files': 0, 'problems': [f'采样库目录不存在：{root or "（BEIMING_SAMPLES 没设）"}'], 'recorded': {}}
    for name in sorted(instruments):
        it = m['instruments'].get(name)
        if it is None:
            problems.append(f'乐器 {name} 不在 engine/audio/samples.json 里：没有固定版本，无法核对')
            continue
        lib_dir = libs[it['library']]['dir']
        base = os.path.join(root, lib_dir, *it['dir'].split('/'))
        want = {f['path']: f for f in it['files']}
        have = {}
        for dp, _, fs in os.walk(base):
            for fn in fs:
                if fn.endswith(AUDIO_EXT):
                    full = os.path.join(dp, fn)
                    have[os.path.relpath(full, base).replace(os.sep, '/')] = full
        for rel in sorted(set(want) - set(have)):
            problems.append(f'{name}：缺 {it["dir"]}/{rel}')
        for rel in sorted(set(have) - set(want)):
            problems.append(f'{name}：多出 {it["dir"]}/{rel}（采样器会把它算进音区与力度层，结果就不是固定版本）')
        for rel in sorted(set(have)):
            with open(have[rel], 'rb') as f:
                b = f.read()
            sha = hashlib.sha256(b).hexdigest()
            key = f'{lib_dir}/{it["dir"]}/{rel}'
            rows.append([key, len(b), sha])
            recorded[key] = sha
            w = want.get(rel)
            if w is None:
                continue
            if len(b) != w['bytes']:
                problems.append(f'{name}：{rel} 是 {len(b)} 字节，清单是 {w["bytes"]}')
            elif w.get('sha256') and w['sha256'] != sha:
                problems.append(f'{name}：{rel} 的 sha256 与清单不符')
            elif w.get('gitBlobSha1') and w['gitBlobSha1'] != _git_blob_sha1(b):
                problems.append(f'{name}：{rel} 的内容与上游固定提交不符（git blob SHA-1 不同）')
    return {'ok': not problems, 'digest': digest(sorted(rows)) if rows else None, 'files': len(rows), 'problems': problems,
            'recorded': recorded}


def inputs(root, code, dur, seed, instruments=None, library=None):
    return {'code': code_hashes(root, code), 'dur': float(dur), 'seed': int(seed),
            'samplesManifest': manifest_digest(instruments) if instruments else None,
            'samplesLibrary': (library or {}).get('digest')}


def _env():
    out = {'python': platform.python_version(), 'platform': f'{platform.system()}-{platform.machine()}', 'numpy': np.__version__}
    for mod in ('scipy', 'soxr', 'soundfile'):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:  # 记录用，缺了不影响
            out[mod] = None
    return out


def _mus_sha(mus):
    return hashlib.sha256(np.ascontiguousarray(mus, dtype='<f4').tobytes()).hexdigest()


def _write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
    os.replace(tmp, path)


def save(npz, lock, mus, harmony, used, inputs_, note=None, sample_rate=48000):
    mus32 = np.ascontiguousarray(mus, dtype=np.float32)
    tmp = npz + '.tmp.npz'
    np.savez_compressed(tmp, mus=mus32, harmony=json.dumps(harmony, ensure_ascii=False), used=json.dumps(list(used)))
    os.replace(tmp, npz)
    doc = {'schema': SCHEMA,
           '说明': '配乐缓存的输入键：audio/mix.py 默认读缓存前先核对这里登记的输入；乐谱、引擎代码、时长、种子或采样库清单变了就拒绝沿用，'
                 '要么 --score 重渲，要么 --accept-stale-score 明确接受旧配乐（会记进 render.json）。',
           'cache': {'file': os.path.basename(npz), 'sha256': file_sha256(npz), 'musSha256': _mus_sha(mus32),
                     'samples': int(mus32.shape[0]), 'sampleRate': sample_rate},
           'frozen': False, 'freeze': None, 'inputs': inputs_, 'renderedWith': _env(), 'note': note}
    _write_json(lock, doc)
    return doc


def _short(h):
    return (h or 'null')[:12]


def load(npz, lock, n_expected, current_fn, accept_stale=False):
    if not os.path.exists(npz):
        raise StaleCache(f'找不到配乐缓存 {npz}', '先渲一次配乐：加 --score（需要 BEIMING_SAMPLES，见 node tools/audio/fetch-samples.mjs）', ['cache'])
    c = np.load(npz)
    mus = c['mus']
    harmony, used = json.loads(str(c['harmony'])), json.loads(str(c['used']))
    if mus.ndim != 2 or mus.shape[1] != 2:
        raise StaleCache(f'配乐缓存的形状是 {mus.shape}，应为 (样本数, 2)', '用 --score 重渲', ['cache'])
    if not os.path.exists(lock):
        raise StaleCache(f'配乐缓存 {os.path.basename(npz)} 没有输入键 {os.path.basename(lock)}：不知道它是用哪份乐谱、哪个采样库渲的',
                         '用 --score 重渲（会同时写出输入键），或确认就要用它时加 --accept-stale-score', ['lock'])
    with open(lock, encoding='utf-8') as f:
        L = json.load(f)
    if L.get('schema') != SCHEMA:
        raise StaleCache(f'{os.path.basename(lock)} 的 schema 是 {L.get("schema")!r}，应为 {SCHEMA}', '用 --score 重渲', ['lock'])
    current = current_fn(used)
    changed, lines = [], []
    if _mus_sha(mus) != L['cache']['musSha256']:
        changed.append('cache')
        lines.append(f'{os.path.basename(npz)} 不是 lock 登记的那一份（内容摘要 {_short(_mus_sha(mus))}，登记 {_short(L["cache"]["musSha256"])}）')
    if mus.shape[0] != n_expected:
        changed.append('length')
        lines.append(f'缓存 {mus.shape[0]} 个样本，这部片要 {n_expected} 个（时长改过了）')
    if L.get('frozen'):
        fz = L.get('freeze') or {}
        want_code, want_dur = fz.get('code', {}), fz.get('dur')
    else:
        want = L.get('inputs') or {}
        want_code, want_dur = want.get('code', {}), want.get('dur')
        for k in ('seed', 'samplesManifest'):
            if want.get(k) != current.get(k):
                changed.append(k)
                lines.append(f'{k} 变了（登记 {want.get(k)!r:.20}，现在 {current.get(k)!r:.20}）')
    cur_code = current.get('code', {})
    for p, h in sorted(want_code.items()):
        if cur_code.get(p) != h:
            changed.append(p)
            lines.append(f'{p} 改过了（登记 sha256 {_short(h)}，现在 {_short(cur_code.get(p))}）')
    if not L.get('frozen'):
        for p in sorted(set(cur_code) - set(want_code)):
            changed.append(p)
            lines.append(f'{p} 不在登记的输入里')
    if want_dur is not None and abs(float(want_dur) - float(current.get('dur', want_dur))) > 1e-9:
        changed.append('dur')
        lines.append(f'时长 {current.get("dur")} 秒，登记 {want_dur} 秒')
    kind = '冻结的定稿配乐' if L.get('frozen') else '配乐缓存'
    if changed:
        msg = f'{kind}与当前输入不一致：' + '；'.join(lines) + '。缓存里的配乐不会反映这些修改'
        hint = ('重渲配乐：加 --score（需要 BEIMING_SAMPLES，取样库见 node tools/audio/fetch-samples.mjs）；'
                '确认就要用旧配乐：加 --accept-stale-score（会记进 render.json）')
        if not accept_stale or 'cache' in changed or 'length' in changed:
            raise StaleCache(msg, hint if 'cache' not in changed and 'length' not in changed else '用 --score 重渲', changed)
        return mus, harmony, used, {'status': 'stale-accepted', 'changed': changed, 'message': msg, 'frozen': bool(L.get('frozen'))}
    if L.get('frozen'):
        fz = L.get('freeze') or {}
        return mus, harmony, used, {'status': 'frozen', 'changed': [], 'frozen': True,
                                    'message': f'定稿配乐（冻结于 {fz.get("date")}；乐谱源码与登记一致）'}
    return mus, harmony, used, {'status': 'match', 'changed': [], 'frozen': False, 'message': '配乐缓存与当前输入一致'}
