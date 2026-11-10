# -*- coding: utf-8 -*-
"""北冥引擎 · 声音侧读作品描述：film.json（v2，也接受 v1 的 {route, title, dur, fps, size}）与交付档位，给 qa / cuecheck / voice 用。

只读、不校验全部契约（完整校验在 engine/production/film.js）；读不到或缺字段时抛 FilmSpecError（带 hint）。
  load(target) → dict：target 是 film.json 路径或作品目录
      {file, dir（路径基准：普通作品是作品目录；mirror.paths = "repo" 的镜像作品是仓库根）, id, title, route, version,
       fps, frameCount, seconds, width, height, profile, shots: [{id, in, out}], cuts: [帧…], events: [...],
       audio: {mode, script, wav, cues, targetLUFS, truePeakDbTP, …}, cuecheck, timeline, voice, raw}
  profile(pid=None) → 交付档位（engine/production/profiles.json；没有这个文件时用决策 D07 的兜底表）
  resolve(film, rel) → 相对路径基准的绝对路径
"""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PROFILES = os.path.join(ROOT, 'engine', 'production', 'profiles.json')

# 决策 D07 / 附录 C7 的兜底（engine/production/profiles.json 存在时以它为准）
_FALLBACK = {
    'web-1080p24': (1920, 1080, 24, -14.0, 1.0, -1.0), 'master-1080p24': (1920, 1080, 24, -14.0, 1.0, -1.0),
    'uhd-2160p24': (3840, 2160, 24, -14.0, 1.0, -1.0), 'vertical-1080x1920-30': (1080, 1920, 30, -14.0, 1.0, -1.0),
    'broadcast-1080p25': (1920, 1080, 25, -23.0, 0.5, -1.0), 'beiming-1040p24': (1920, 1040, 24, -14.0, 1.0, -1.2),
}
DEFAULT_PROFILE = 'web-1080p24'


class FilmSpecError(Exception):
    def __init__(self, code, message, hint=None):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint


def _profiles():
    if os.path.exists(PROFILES):
        with open(PROFILES, encoding='utf-8') as f:
            d = json.load(f)
        return d.get('default', DEFAULT_PROFILE), d['profiles']
    out = {}
    for k, (w, h, fps, lufs, tol, tp) in _FALLBACK.items():
        out[k] = {'video': {'width': w, 'height': h, 'fps': fps},
                  'audio': {'codec': 'aac', 'sampleRate': 48000, 'channels': 2,
                            'loudness': {'integratedLUFS': lufs, 'toleranceLU': tol}, 'truePeakMaxDbTP': tp}}
    return DEFAULT_PROFILE, out


def profile(pid=None):
    default, ps = _profiles()
    pid = pid or default
    if pid not in ps:
        raise FilmSpecError('usage.profile-unknown', f'没有交付档位 {pid!r}', f'可用：{"、".join(ps)}（默认 {default}）')
    return dict(ps[pid], id=pid)


def _match_profile(w, h, fps):
    default, ps = _profiles()
    hits = [k for k, p in ps.items() if (p['video']['width'], p['video']['height'], p['video']['fps']) == (w, h, fps)]
    if default in hits:
        return default
    return hits[0] if hits else None


def load(target):
    p = os.path.abspath(target)
    file = os.path.join(p, 'film.json') if os.path.isdir(p) else p
    if not os.path.exists(file):
        raise FilmSpecError('env.film-missing', f'找不到 {file}', '给作品目录（里面有 film.json）或 film.json 的路径')
    try:
        with open(file, encoding='utf-8') as f:
            raw = json.load(f)
    except ValueError as e:
        raise FilmSpecError('contract.film-json', f'{file} 不是合法 JSON：{e}', '先跑 node engine/production/film.js check 看具体位置') from None
    fdir = os.path.dirname(file)
    base = ROOT if (raw.get('mirror') or {}).get('paths') == 'repo' else fdir
    if raw.get('schemaVersion') == 2:
        out = raw.get('output') or {}
        fps, n = out.get('fps'), out.get('frameCount')
        w, h = out.get('width'), out.get('height')
        pid = out.get('profile')
        shots = [{'id': s.get('id'), 'in': s.get('in'), 'out': s.get('out')} for s in raw.get('shots') or []]
        version = 2
    else:
        fps, dur = raw.get('fps', 24), raw.get('dur')
        if not isinstance(dur, (int, float)) or dur <= 0:
            raise FilmSpecError('contract.film-dur', f'{file}：v1 记录要有正数 dur（秒）', '或者升级到 v2：output.frameCount')
        n = int(round(dur * fps))
        w, h = (raw.get('size') or [1920, 1080])[:2]
        pid, shots, version = None, [], 1
    if not (isinstance(fps, int) and fps > 0 and isinstance(n, int) and n > 0):
        raise FilmSpecError('contract.film-output', f'{file}：output.fps / output.frameCount 要是正整数（收到 {fps!r} / {n!r}）',
                            'node engine/production/film.js check 看完整诊断')
    pid = pid or _match_profile(w, h, fps) or DEFAULT_PROFILE
    audio = dict(raw.get('audio') or {})
    if version == 1 and not audio:
        for name in ('sound.py', 'mix.py'):
            if os.path.exists(os.path.join(fdir, name)):
                audio = {'mode': 'script', 'script': name}
                break
    cuts = sorted({s['in'] for s in shots if isinstance(s.get('in'), int) and s['in'] > 0})
    return {'file': file, 'dir': base, 'filmDir': fdir, 'id': raw.get('id') or os.path.basename(fdir), 'title': raw.get('title'),
            'route': raw.get('route'), 'version': version, 'fps': fps, 'frameCount': n, 'seconds': n / fps,
            'width': w, 'height': h, 'profile': pid, 'shots': shots, 'cuts': cuts, 'events': list(raw.get('events') or []),
            'audio': audio, 'cuecheck': raw.get('cuecheck'), 'timeline': raw.get('timeline'), 'voice': raw.get('voice'), 'raw': raw}


def resolve(film, rel):
    return rel if os.path.isabs(rel) else os.path.normpath(os.path.join(film['dir'], *str(rel).split('/')))
