# -*- coding: utf-8 -*-
"""北冥引擎 · 情绪导引乐谱与 ACE-Step 1.5 Cover 配乐生成（python -m engine.audio.music_gen，Node 入口 tools/audio/music.mjs）。

为什么采用「程序化导引轨（Guide Score）+ ACE-Step 1.5 Cover 模式」双层架构：
  纯文生音乐（Text-to-Music）容易在中段断片或结尾提前塌陷；先依据 film.json 的镜头切点与事件帧合成一条精确对齐画面时间轴的
  48 kHz 立体声导引乐谱（guide.wav：大提琴/弦乐温暖和声铺底 + 锁拍竖琴分解琶音 + 切镜前呼吸渐强引子 + 终章高八度辉煌抬升），
  再送入 ACE-Step 1.5 Cover 模式（task_type='cover', src_audio, audio_cover_strength），即可把和声换挡、切镜推浪、留白呼吸与终章高潮
  牢牢锁死在影片的精确整数帧时间轴上，同时支持 --provider guide 纯本机确定性预演（动态预演与离线 CI 用）。

公开接口：
  plan_sections_from_film(film_or_dir) -> dict
      读取 film.json（及可选 music.json / audio.music 配置），从镜头表与事件表推导叙事配乐分段：
      {'dur', 'fps', 'key', 'scale', 'bpm', 'sections': [{'id', 't0', 't1', 'energy', 'mood', 'chord_deg'}]}
  build_guide_score(spec_or_sections, *, dur=None, fps=24, key='D', scale='major', bpm=96.0, sr=48000, seed=42) -> (guide_st, meta_dict)
      确定性合成 48 kHz（或指定 sr）立体声导引配乐，峰值归一至 -3.0 dBFS，首尾严格归零无爆音，终章能量与织体显著高于开场
  generate_cover(guide_wav_or_arr, *, prompt, lyrics='[inst]', dur=None, endpoint=None, ssh_host=None, remote_port=8001,
                 cover_strength=0.45, steps=8, guidance_scale=4.5, seed=42, provider='acestep', cache_dir=None,
                 out_wav=None, offline=False, timeout_s=300.0, sr=48000) -> dict
      调用 ACE-Step 1.5 HTTP API（支持本地/远端 URL 或免密 SSH 临时端口转发，try/finally 零残留清理）或 guide 离线确定性模式，
      按输入键 sha256 读写磁盘缓存，重采样至精确 N(dur) 立体声样本（15 ms 淡入 / 120 ms 淡出，PCM_24），并附带 D11 AIGC 标识元数据

命令行：
  python -m engine.audio.music_gen guide [film] [--out <guide.wav>] [--key D] [--scale major] [--bpm 96] [--seed 42]
  python -m engine.audio.music_gen build [film] [--prompt <str>] [--lyrics <str>] [--guide <wav>] [--out <music.wav>]
      [--cache <dir>] [--provider acestep|guide] [--endpoint <url>] [--ssh <ssh-alias>] [--remote-port 8001]
      [--cover-strength 0.45] [--steps 8] [--guidance-scale 4.5] [--seed 42] [--timeout 300] [--offline]
  python -m engine.audio.music_gen probe [--endpoint <url>] [--ssh <ssh-alias>] [--remote-port 8001] [--timeout 10]
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import io
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt
import soundfile as sf
import soxr

from ._cli import ArgumentParser, CliError, rel, run, sha256_file
from . import _env
from .dsp import SR, fade, make_ir, pan_lr, rng, smoothstep, undb
from . import filmspec as FS
from .meter import integrated

__all__ = [
    'SCALES',
    'NOTE_OFFSETS',
    'AIGC_ACESTEP',
    'AIGC_GUIDE',
    'plan_sections_from_film',
    'build_guide_score',
    'generate_cover',
    'probe_endpoint',
    'make_parser',
    'main',
]

CACHE_SCHEMA = 'beiming.music-cache/1'

AIGC_ACESTEP = {
    'contains': True,
    'kinds': ['music'],
    'tools': ['ACE-Step-1.5'],
    'note': '配乐由 ACE-Step 1.5 Cover 模式依据程序化导引轨生成',
}

AIGC_GUIDE = {
    'contains': False,
    'kinds': [],
    'tools': [],
    'note': '程序化合成导引配乐（不含 AI 生成）',
}

NOTE_OFFSETS = {
    'C': 0, 'B#': 0,
    'C#': 1, 'DB': 1,
    'D': 2,
    'D#': 3, 'EB': 3,
    'E': 4, 'FB': 4,
    'F': 5, 'E#': 5,
    'F#': 6, 'GB': 6,
    'G': 7,
    'G#': 8, 'AB': 8,
    'A': 9,
    'A#': 10, 'BB': 10,
    'B': 11, 'CB': 11,
}

SCALES = {
    'major': (0, 2, 4, 5, 7, 9, 11),
    'ionian': (0, 2, 4, 5, 7, 9, 11),
    'minor': (0, 2, 3, 5, 7, 8, 10),
    'aeolian': (0, 2, 3, 5, 7, 8, 10),
    'dorian': (0, 2, 3, 5, 7, 9, 10),
    'mixolydian': (0, 2, 4, 5, 7, 9, 10),
    'lydian': (0, 2, 4, 6, 7, 9, 11),
    'pentatonic': (0, 2, 4, 7, 9, 12, 14),
    'minor-pentatonic': (0, 3, 5, 7, 10, 12, 15),
    'minor_pentatonic': (0, 3, 5, 7, 10, 12, 15),
}

_PROGRESSION_MAJOR = {
    'establishing': [1, 5, 6, 4],
    'development': [4, 1, 5, 6],
    'rising': [2, 6, 4, 5],
    'suspension': [4, 2, 5, 5],
    'climax': [6, 4, 1, 5],
}

_PROGRESSION_MINOR = {
    'establishing': [1, 6, 3, 7],
    'development': [4, 7, 3, 6],
    'rising': [6, 7, 1, 5],
    'suspension': [4, 2, 5, 5],
    'climax': [6, 7, 3, 1],
}


def _parse_key_and_scale(key: str | None, scale: str | None) -> tuple[str, str]:
    raw_k = (key or 'D').strip()
    raw_s = (scale or '').strip().lower()
    if len(raw_k) >= 2 and raw_k.endswith(('m', 'M')):
        stem = raw_k[:-1].strip()
        if stem.upper() in NOTE_OFFSETS and raw_k.endswith('m'):
            raw_k = stem
            if not raw_s or raw_s == 'major':
                raw_s = 'minor'
    norm_k = (raw_k[0].upper() + raw_k[1:].lower().replace('s', '#')) if raw_k else 'D'
    if norm_k.upper() not in NOTE_OFFSETS:
        raise CliError(
            'usage.bad-value',
            f'不认识的调性主音 {key!r}',
            hint='示例：D、C、F#、Bb、Am',
        )
    if not raw_s:
        raw_s = 'major'
    if raw_s not in SCALES:
        raise CliError(
            'usage.bad-value',
            f'不认识的音阶类型 {scale!r}',
            hint=f'可选：{" / ".join(sorted(SCALES))}',
        )
    return norm_k, raw_s


def _degree_midi(root_semi: int, scale_iv: tuple[int, ...], deg: int, base_octave: int = 3) -> int:
    """将 1 基音阶度数（1..7 或更高跨八度度数）映射为 MIDI 音高。"""
    d0 = int(deg) - 1
    n_iv = len(scale_iv)
    oct_shift, idx = divmod(d0, n_iv)
    semi = scale_iv[idx]
    # 对五声音阶做跨周期自然八度折算
    if scale_iv[-1] >= 12:
        base_span = 12
    else:
        base_span = 12
    return 12 * (base_octave + 1 + oct_shift) + root_semi + (semi if oct_shift == 0 else (semi % base_span))


def _midi_to_hz(midi_note: float) -> float:
    return 440.0 * (2.0 ** ((float(midi_note) - 69.0) / 12.0))


def _load_film_and_music_cfg(film_or_dir) -> tuple[dict, dict]:
    if isinstance(film_or_dir, dict):
        if 'seconds' in film_or_dir and 'fps' in film_or_dir:
            film = film_or_dir
        else:
            raw = film_or_dir
            out = raw.get('output') or {}
            fps = int(out.get('fps') or raw.get('fps') or 24)
            frames = out.get('frameCount')
            if frames is None:
                dur_v = float(raw.get('dur') or 8.0)
                frames = max(1, int(round(dur_v * fps)))
            shots = [{'id': s.get('id'), 'in': s.get('in'), 'out': s.get('out')} for s in (raw.get('shots') or [])]
            film = {
                'fps': fps,
                'frameCount': int(frames),
                'seconds': int(frames) / float(fps),
                'shots': shots,
                'events': list(raw.get('events') or []),
                'audio': dict(raw.get('audio') or {}),
                'raw': raw,
                'filmDir': None,
                'dir': None,
            }
    else:
        try:
            film = FS.load(str(film_or_dir))
        except FS.FilmSpecError as exc:
            raise CliError(exc.code, exc.message, hint=exc.hint) from None

    music_cfg = {}
    raw_doc = film.get('raw') or {}
    if isinstance(raw_doc.get('music'), dict):
        music_cfg.update(raw_doc['music'])
    audio_doc = film.get('audio') or {}
    if isinstance(audio_doc.get('music'), dict):
        music_cfg.update(audio_doc['music'])

    for base_key in ('filmDir', 'dir'):
        bdir = film.get(base_key)
        if bdir and os.path.isdir(str(bdir)):
            mpath = os.path.join(str(bdir), 'music.json')
            if os.path.isfile(mpath):
                try:
                    with open(mpath, encoding='utf-8') as f:
                        file_cfg = json.load(f)
                    if isinstance(file_cfg, dict):
                        music_cfg.update(file_cfg)
                except ValueError as exc:
                    raise CliError('contract.music-json', f'{rel(mpath)} 不是合法 JSON：{exc}', hint='检查 music.json 语法') from None
                break

    return film, music_cfg


def _snap_frame_time(t_sec: float, fps: int, lo_s: float, hi_s: float) -> float:
    f = int(round(t_sec * fps))
    snapped = f / float(fps)
    if snapped <= lo_s + 0.5 / fps or snapped >= hi_s - 0.5 / fps:
        return 0.5 * (lo_s + hi_s)
    return snapped


def _progression_for(mood: str, scale: str) -> list[int]:
    is_min = scale in ('minor', 'aeolian', 'dorian', 'minor-pentatonic', 'minor_pentatonic')
    table = _PROGRESSION_MINOR if is_min else _PROGRESSION_MAJOR
    return list(table.get(mood, table['development']))


def plan_sections_from_film(film_or_dir) -> dict:
    """从 film.json 的镜头表（shots）与事件表（events）自动推导情绪叙事弧线配乐分段。

    返回：
      {
        'dur': float,
        'fps': int,
        'key': str,
        'scale': str,
        'bpm': float,
        'sections': [
          {'id': str, 't0': float, 't1': float, 'energy': float, 'mood': str, 'chord_deg': list[int]},
          ...
        ]
      }
    """
    film, mcfg = _load_film_and_music_cfg(film_or_dir)
    dur = float(film['seconds'])
    fps = int(film['fps'])
    key, scale = _parse_key_and_scale(mcfg.get('key'), mcfg.get('scale'))
    bpm = float(mcfg.get('bpm', 96.0))
    if not (20.0 <= bpm <= 300.0):
        raise CliError('usage.bad-value', f'BPM 超出合理范围（20..300）：{bpm!r}')

    # 若配置显式给出了分段表，做规范化整理后直接采用
    explicit_secs = mcfg.get('sections')
    if isinstance(explicit_secs, list) and explicit_secs:
        norm_secs = []
        for idx, s in enumerate(explicit_secs):
            t0 = float(s.get('t0', 0.0 if idx == 0 else norm_secs[-1]['t1']))
            t1 = float(s.get('t1', dur if idx == len(explicit_secs) - 1 else dur))
            if t1 <= t0:
                continue
            mood = str(s.get('mood') or ('establishing' if idx == 0 else ('climax' if idx == len(explicit_secs) - 1 else 'development')))
            cdeg = [int(d) for d in (s.get('chord_deg') or _progression_for(mood, scale))]
            norm_secs.append({
                'id': str(s.get('id') or f'sec_{idx + 1}'),
                't0': round(t0, 6),
                't1': round(t1, 6),
                'energy': round(float(np.clip(s.get('energy', 0.55), 0.10, 1.0)), 4),
                'mood': mood,
                'chord_deg': cdeg,
            })
        if norm_secs:
            norm_secs[0]['t0'] = 0.0
            norm_secs[-1]['t1'] = dur
            return {'dur': dur, 'fps': fps, 'key': key, 'scale': scale, 'bpm': bpm, 'sections': norm_secs}

    raw_shots = []
    for idx, s in enumerate(film.get('shots') or []):
        sin, sout = s.get('in'), s.get('out')
        if isinstance(sin, int) and isinstance(sout, int) and sout > sin:
            raw_shots.append({
                'id': str(s.get('id') or f'S{idx + 1}'),
                't0': sin / float(fps),
                't1': sout / float(fps),
            })

    # 确保镜头表连续覆盖 [0, dur]
    if raw_shots:
        raw_shots.sort(key=lambda item: item['t0'])
        raw_shots[0]['t0'] = 0.0
        for i in range(len(raw_shots) - 1):
            raw_shots[i]['t1'] = raw_shots[i + 1]['t0']
        raw_shots[-1]['t1'] = dur

    ev_times = sorted(FS.event_times(film).values())

    def _event_boost(t0: float, t1: float) -> float:
        cnt = sum(1 for te in ev_times if t0 <= te < t1)
        return min(0.08, 0.025 * cnt)

    sections: list[dict] = []
    n_shots = len(raw_shots)

    if n_shots <= 1:
        base_id = raw_shots[0]['id'] if n_shots == 1 else 'S1'
        if dur >= 4.0:
            c1 = _snap_frame_time(0.28 * dur, fps, 0.0, dur)
            c2 = _snap_frame_time(0.60 * dur, fps, c1, dur)
            c3 = _snap_frame_time(0.72 * dur, fps, c2, dur)
            spans = [
                (f'{base_id}_intro', 0.0, c1, 0.35, 'establishing'),
                (f'{base_id}_dev', c1, c2, round(min(0.68, 0.56 + _event_boost(c1, c2)), 4), 'development'),
                (f'{base_id}_breath', c2, c3, 0.42, 'suspension'),
                (f'{base_id}_finale', c3, dur, 0.92, 'climax'),
            ]
        else:
            cmid = _snap_frame_time(0.45 * dur, fps, 0.0, dur)
            spans = [
                (f'{base_id}_intro', 0.0, cmid, 0.35, 'establishing'),
                (f'{base_id}_finale', cmid, dur, 0.92, 'climax'),
            ]
        for sid, a, b, eng, mood in spans:
            if b > a:
                sections.append({
                    'id': sid,
                    't0': a,
                    't1': b,
                    'energy': eng,
                    'mood': mood,
                    'chord_deg': _progression_for(mood, scale),
                })

    elif n_shots == 2:
        s0, s1 = raw_shots[0], raw_shots[1]
        d0 = s0['t1'] - s0['t0']
        if d0 >= 3.2:
            t_dev = _snap_frame_time(s0['t0'] + 0.46 * d0, fps, s0['t0'], s0['t1'])
            breath_len = min(0.85, max(0.40, 0.20 * d0))
            t_br = _snap_frame_time(s0['t1'] - breath_len, fps, t_dev, s0['t1'])
            sections.append({
                'id': f"{s0['id']}_intro",
                't0': s0['t0'],
                't1': t_dev,
                'energy': 0.35,
                'mood': 'establishing',
                'chord_deg': _progression_for('establishing', scale),
            })
            sections.append({
                'id': f"{s0['id']}_dev",
                't0': t_dev,
                't1': t_br,
                'energy': round(min(0.68, 0.56 + _event_boost(t_dev, t_br)), 4),
                'mood': 'development',
                'chord_deg': _progression_for('development', scale),
            })
            sections.append({
                'id': f"{s0['id']}_breath",
                't0': t_br,
                't1': s0['t1'],
                'energy': 0.42,
                'mood': 'suspension',
                'chord_deg': _progression_for('suspension', scale),
            })
        else:
            sections.append({
                'id': s0['id'],
                't0': s0['t0'],
                't1': s0['t1'],
                'energy': 0.35,
                'mood': 'establishing',
                'chord_deg': _progression_for('establishing', scale),
            })
        sections.append({
            'id': s1['id'],
            't0': s1['t0'],
            't1': s1['t1'],
            'energy': 0.92,
            'mood': 'climax',
            'chord_deg': _progression_for('climax', scale),
        })

    elif n_shots == 3:
        s0, s1, s2 = raw_shots
        sections.append({
            'id': s0['id'],
            't0': s0['t0'],
            't1': s0['t1'],
            'energy': 0.35,
            'mood': 'establishing',
            'chord_deg': _progression_for('establishing', scale),
        })
        d1 = s1['t1'] - s1['t0']
        if d1 >= 2.0:
            breath_len = min(0.95, max(0.42, 0.24 * d1))
            t_br = _snap_frame_time(s1['t1'] - breath_len, fps, s1['t0'], s1['t1'])
            sections.append({
                'id': f"{s1['id']}_dev",
                't0': s1['t0'],
                't1': t_br,
                'energy': round(min(0.70, 0.58 + _event_boost(s1['t0'], t_br)), 4),
                'mood': 'development',
                'chord_deg': _progression_for('development', scale),
            })
            sections.append({
                'id': f"{s1['id']}_breath",
                't0': t_br,
                't1': s1['t1'],
                'energy': 0.42,
                'mood': 'suspension',
                'chord_deg': _progression_for('suspension', scale),
            })
        else:
            sections.append({
                'id': s1['id'],
                't0': s1['t0'],
                't1': s1['t1'],
                'energy': round(min(0.68, 0.55 + _event_boost(s1['t0'], s1['t1'])), 4),
                'mood': 'development',
                'chord_deg': _progression_for('development', scale),
            })
        sections.append({
            'id': s2['id'],
            't0': s2['t0'],
            't1': s2['t1'],
            'energy': 0.92,
            'mood': 'climax',
            'chord_deg': _progression_for('climax', scale),
        })

    else:
        n_mid = max(1, n_shots - 3)
        for idx, sh in enumerate(raw_shots):
            a, b = sh['t0'], sh['t1']
            if idx == 0:
                eng, mood = 0.35, 'establishing'
            elif idx == n_shots - 1:
                eng, mood = 0.92, 'climax'
            elif idx == n_shots - 2:
                eng, mood = 0.43, 'suspension'
            else:
                prog = (idx - 1) / float(max(1, n_mid - 1)) if n_mid > 1 else 0.5
                base_e = 0.52 + 0.16 * prog
                eng = round(min(0.72, base_e + _event_boost(a, b)), 4)
                mood = 'rising' if prog > 0.55 else 'development'
            sections.append({
                'id': sh['id'],
                't0': a,
                't1': b,
                'energy': eng,
                'mood': mood,
                'chord_deg': _progression_for(mood, scale),
            })

    sections[0]['t0'] = 0.0
    sections[-1]['t1'] = dur
    return {
        'dur': dur,
        'fps': fps,
        'key': key,
        'scale': scale,
        'bpm': bpm,
        'sections': sections,
    }


def _synth_warm_pad_voice(freq_hz: float, n: int, sr: int, r: np.random.Generator,
                          bright: float = 0.5, vibrato: float = 0.0) -> np.ndarray:
    """合成温暖饱满的立体声弓弦/大提琴铺底单音（双声道微失谐合唱，保证高单声道相关性且无相位抵消）。"""
    if n <= 0 or freq_hz <= 20.0 or freq_hz >= 0.44 * sr:
        return np.zeros((max(0, n), 2), dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / float(sr)
    vib = vibrato * np.sin(2.0 * math.pi * 5.2 * t + float(r.uniform(0.0, 2.0 * math.pi))) if vibrato > 0 else 0.0
    left = np.zeros(n, dtype=np.float64)
    right = np.zeros(n, dtype=np.float64)
    tilt = 1.32 - 0.42 * float(np.clip(bright, 0.0, 1.0))
    max_h = 10 if bright >= 0.65 else 7
    for k in range(1, max_h + 1):
        fk = freq_hz * k
        if fk >= 0.43 * sr:
            break
        amp = (1.0 / (k ** tilt)) * (1.18 if k in (2, 3) else 1.0)
        det = 0.0016 * (1.0 + 0.15 * k)
        ph_l = float(r.uniform(0.0, 2.0 * math.pi))
        ph_r = ph_l + float(r.uniform(-0.22, 0.22))
        if vibrato > 0:
            inst_l = fk * (1.0 - det + vib)
            inst_r = fk * (1.0 + det + vib)
            left += amp * np.sin(2.0 * math.pi * np.cumsum(inst_l) / float(sr) + ph_l)
            right += amp * np.sin(2.0 * math.pi * np.cumsum(inst_r) / float(sr) + ph_r)
        else:
            left += amp * np.sin(2.0 * math.pi * (fk * (1.0 - det)) * t + ph_l)
            right += amp * np.sin(2.0 * math.pi * (fk * (1.0 + det)) * t + ph_r)
    cutoff = min(0.42 * sr, 880.0 + 3600.0 * (float(np.clip(bright, 0.0, 1.0)) ** 1.25))
    sos = butter(2, cutoff, 'low', fs=float(sr), output='sos')
    st = np.stack([left, right], axis=1)
    return sosfilt(sos, st, axis=0) * 0.42


def _synth_pluck_note(freq_hz: float, dur_s: float, sr: int, r: np.random.Generator,
                      vel: float = 0.7, sparkle: float = 0.0) -> np.ndarray:
    """合成音乐会竖琴/拨弦脉冲音粒（高次谐波先衰减，圆润无毛刺）。"""
    n = max(16, int(round(dur_s * sr)))
    if freq_hz <= 25.0 or freq_hz >= 0.44 * sr:
        return np.zeros(n, dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / float(sr)
    atk = smoothstep(0.0, min(0.0022, 0.15 * dur_s), t)
    rel_tail = 1.0 - smoothstep(max(0.0, dur_s - 0.025), dur_s, t)
    out = np.zeros(n, dtype=np.float64)
    base_tau = max(0.09, min(1.25, dur_s * 0.72))
    n_harm = 7 if sparkle > 0.25 else 5
    for k in range(1, n_harm + 1):
        fk = freq_hz * k
        if fk >= 0.43 * sr:
            break
        tau_k = base_tau / (1.0 + 0.55 * (k - 1))
        amp_k = (vel ** (1.0 + 0.15 * (k - 1))) / (k ** (1.08 - 0.22 * sparkle))
        ph = float(r.uniform(0.0, 0.35))
        out += amp_k * np.exp(-t / tau_k) * np.sin(2.0 * math.pi * fk * t + ph)
    if sparkle > 0.35 and freq_hz * 2.0 < 0.42 * sr:
        # 高潮段叠加清透钢片琴/竖琴八度泛音星芒
        out += 0.22 * sparkle * vel * np.exp(-t / (0.35 * base_tau)) * np.sin(2.0 * math.pi * (freq_hz * 2.0) * t)
    return out * atk * rel_tail * 0.38


def _place_stereo(buf: np.ndarray, sig: np.ndarray, start_idx: int, gain: float = 1.0, pan: float = 0.0) -> None:
    if len(sig) == 0 or start_idx >= len(buf) or start_idx + len(sig) <= 0:
        return
    s0 = start_idx
    x = sig
    if s0 < 0:
        x = x[-s0:]
        s0 = 0
    e0 = min(len(buf), s0 + len(x))
    if e0 <= s0:
        return
    seg = x[:e0 - s0]
    if seg.ndim == 1:
        gl, gr = pan_lr(float(np.clip(pan, -0.45, 0.45)))
        buf[s0:e0, 0] += seg * (gain * gl)
        buf[s0:e0, 1] += seg * (gain * gr)
    else:
        buf[s0:e0] += seg * gain


def build_guide_score(
    spec_or_sections,
    *,
    dur: float = None,
    fps: int = 24,
    key: str = 'D',
    scale: str = 'major',
    bpm: float = 96.0,
    sr: int = 48000,
    seed: int = 42,
) -> tuple[np.ndarray, dict]:
    """确定性合成 48 kHz（或指定 sr）立体声情绪导引乐谱，峰值归一至 -3.0 dBFS，首尾归零无爆音。"""
    sr_out = int(sr)
    if sr_out < 8000:
        raise CliError('usage.bad-value', f'采样率 sr 过低：{sr_out}')

    if isinstance(spec_or_sections, (str, os.PathLike)):
        plan = plan_sections_from_film(spec_or_sections)
    elif isinstance(spec_or_sections, dict) and 'sections' not in spec_or_sections:
        plan = plan_sections_from_film(spec_or_sections)
    elif isinstance(spec_or_sections, dict):
        plan = spec_or_sections
    elif isinstance(spec_or_sections, (list, tuple)):
        plan = {'sections': list(spec_or_sections)}
    else:
        raise CliError('usage.bad-value', f'不认识的乐谱规格类型：{type(spec_or_sections).__name__}')

    eff_fps = int(plan.get('fps', fps) if fps == 24 and 'fps' in plan else fps)
    eff_key_in = plan.get('key', key) if key == 'D' and 'key' in plan else key
    eff_scale_in = plan.get('scale', scale) if scale == 'major' and 'scale' in plan else scale
    eff_bpm = float(plan.get('bpm', bpm) if bpm == 96.0 and 'bpm' in plan else bpm)
    eff_key, eff_scale = _parse_key_and_scale(eff_key_in, eff_scale_in)

    raw_secs = list(plan.get('sections') or [])
    eff_dur = float(dur if dur is not None else (plan.get('dur') or (max(float(s['t1']) for s in raw_secs) if raw_secs else 8.0)))
    if eff_dur <= 0.0:
        raise CliError('usage.bad-value', f'导引轨时长必须大于 0，收到 {eff_dur!r}')

    if not raw_secs:
        raw_secs = [{
            'id': 'S1_intro', 't0': 0.0, 't1': 0.45 * eff_dur, 'energy': 0.35,
            'mood': 'establishing', 'chord_deg': _progression_for('establishing', eff_scale),
        }, {
            'id': 'S2_finale', 't0': 0.45 * eff_dur, 't1': eff_dur, 'energy': 0.92,
            'mood': 'climax', 'chord_deg': _progression_for('climax', eff_scale),
        }]

    # 归一化分段边界以覆盖完整 [0, eff_dur]，绝不留静音断档
    secs = []
    for idx, s in enumerate(raw_secs):
        t0 = float(s.get('t0', 0.0 if idx == 0 else secs[-1]['t1']))
        t1 = float(s.get('t1', eff_dur))
        t0 = max(0.0, min(eff_dur, t0))
        t1 = max(t0, min(eff_dur, t1))
        if t1 <= t0 + 1e-6:
            continue
        mood = str(s.get('mood') or 'development')
        degs = [int(d) for d in (s.get('chord_deg') or _progression_for(mood, eff_scale))]
        secs.append({
            'id': str(s.get('id') or f'sec_{idx + 1}'),
            't0': t0,
            't1': t1,
            'energy': float(np.clip(s.get('energy', 0.55), 0.15, 1.0)),
            'mood': mood,
            'chord_deg': degs or [1, 5],
        })
    if not secs:
        secs = [{
            'id': 'S1', 't0': 0.0, 't1': eff_dur, 'energy': 0.65,
            'mood': 'development', 'chord_deg': _progression_for('development', eff_scale),
        }]
    secs[0]['t0'] = 0.0
    for i in range(len(secs) - 1):
        secs[i]['t1'] = secs[i + 1]['t0']
    secs[-1]['t1'] = eff_dur

    # 内部统一按 48 kHz 高精度合成，若调用方要求其它采样率最后用 soxr 精确转换
    synth_sr = SR
    n_synth = max(2, int(round(eff_dur * synth_sr)))
    r = rng(int(seed))
    root_semi = NOTE_OFFSETS[eff_key.upper()]
    scale_iv = SCALES[eff_scale]
    spb = 60.0 / max(20.0, eff_bpm)

    pad_bus = np.zeros((n_synth, 2), dtype=np.float64)
    arp_bus = np.zeros((n_synth, 2), dtype=np.float64)
    riser_bus = np.zeros((n_synth, 2), dtype=np.float64)

    for s_idx, sec in enumerate(secs):
        t0, t1 = sec['t0'], sec['t1']
        sec_dur = t1 - t0
        energy = sec['energy']
        degs = sec['chord_deg']
        is_high = energy >= 0.75
        is_breath = sec['mood'] == 'suspension' or energy < 0.45

        # 分段宏观振幅曲线：保证高能量终章相比低能量开场拥有显著的动态与织体抬升（+6~+9 dB）
        sec_amp = 0.17 + 0.83 * (energy ** 1.50)

        # 将本段按拍长切分为和弦槽位（每槽约 2 拍，短段至少走完核心和弦）
        target_slot = max(0.45, 2.0 * spb)
        n_slots = max(1, min(max(len(degs), int(round(sec_dur / target_slot))), max(1, int(sec_dur / 0.30))))
        slot_dur = sec_dur / float(n_slots)

        for k_slot in range(n_slots):
            ct0 = t0 + k_slot * slot_dur
            ct1 = t0 + (k_slot + 1) * slot_dur
            deg = degs[k_slot % len(degs)]

            # 跨和弦与跨段落重叠余韵（消除一切切点硬断或中段死寂）
            ov_in = 0.0 if (s_idx == 0 and k_slot == 0) else min(0.28, 0.35 * slot_dur)
            ov_out = 0.0 if (s_idx == len(secs) - 1 and k_slot == n_slots - 1) else min(0.34, 0.42 * slot_dur)
            wt0 = max(0.0, ct0 - ov_in)
            wt1 = min(eff_dur, ct1 + ov_out)
            i0 = int(round(wt0 * synth_sr))
            i1 = min(n_synth, int(round(wt1 * synth_sr)))
            m = i1 - i0
            if m <= 16:
                continue

            tw = np.arange(m, dtype=np.float64) / float(synth_sr)
            w_dur = m / float(synth_sr)
            atk_s = 0.025 if (s_idx == 0 and k_slot == 0) else max(0.05, ov_in + 0.08)
            rel_s = 0.05 if (s_idx == len(secs) - 1 and k_slot == n_slots - 1) else max(0.06, ov_out + 0.08)
            env = smoothstep(0.0, min(atk_s, 0.48 * w_dur), tw) * (1.0 - smoothstep(max(0.0, w_dur - rel_s), w_dur, tw))

            # 和弦声部构建：低音大提琴根音 + 中提琴五音 + 三音和声（呼吸段改挂留二度/四度保温暖悬停）
            m_root_bass = _degree_midi(root_semi, scale_iv, deg, base_octave=2)
            m_root_mid = _degree_midi(root_semi, scale_iv, deg, base_octave=3)
            m_fifth = _degree_midi(root_semi, scale_iv, deg + 4, base_octave=3)
            m_color = _degree_midi(root_semi, scale_iv, deg + (1 if sec['mood'] == 'suspension' else 2), base_octave=4)

            chord_st = np.zeros((m, 2), dtype=np.float64)
            bass_gain = 0.52 if sec['mood'] == 'suspension' else (0.85 + 0.30 * energy)
            chord_st += _synth_warm_pad_voice(_midi_to_hz(m_root_bass), m, synth_sr, r, bright=0.35 * energy) * bass_gain
            chord_st += _synth_warm_pad_voice(_midi_to_hz(m_root_mid), m, synth_sr, r, bright=0.55 * energy) * 0.78
            chord_st += _synth_warm_pad_voice(_midi_to_hz(m_fifth), m, synth_sr, r, bright=0.65 * energy) * 0.66
            chord_st += _synth_warm_pad_voice(
                _midi_to_hz(m_color), m, synth_sr, r,
                bright=0.75 * energy, vibrato=0.0025 if energy >= 0.5 else 0.0,
            ) * 0.56

            # 高能量终章（>= 0.75）：叠加辉煌高八度主音弦乐歌唱声部 + 高五度圆号/小提琴泛音抬升！
            if is_high:
                m_oct_hi = _degree_midi(root_semi, scale_iv, deg, base_octave=5)
                m_fifth_hi = _degree_midi(root_semi, scale_iv, deg + 4, base_octave=4)
                m_ninth_hi = _degree_midi(root_semi, scale_iv, deg + 1, base_octave=5)
                # 终章内部渐次攀升推力
                slot_lift = 1.0 + 0.18 * (k_slot / float(max(1, n_slots - 1)))
                chord_st += _synth_warm_pad_voice(
                    _midi_to_hz(m_oct_hi), m, synth_sr, r, bright=0.95, vibrato=0.0038,
                ) * (0.76 * slot_lift)
                chord_st += _synth_warm_pad_voice(
                    _midi_to_hz(m_fifth_hi), m, synth_sr, r, bright=0.88, vibrato=0.0028,
                ) * (0.64 * slot_lift)
                chord_st += _synth_warm_pad_voice(
                    _midi_to_hz(m_ninth_hi), m, synth_sr, r, bright=0.85,
                ) * 0.34
                sec_slot_amp = sec_amp * slot_lift
            else:
                sec_slot_amp = sec_amp

            pad_bus[i0:i1] += chord_st * (env[:, None] * sec_slot_amp)

            # 锁拍琶音脉冲（Arpeggio / Pluck Pulse）：细分密度与力度严格跟随段落 energy
            subdiv = 4 if is_high else (1 if is_breath else 2)
            step_s = spb / float(subdiv)
            arp_degs = (
                [deg, deg + 2, deg + 4, deg + 7, deg + 9, deg + 11, deg + 9, deg + 7]
                if is_high
                else ([deg, deg + 4, deg + 7, deg + 4] if not is_breath else [deg + 4, deg + 7])
            )
            # 对齐到全局节拍网格
            first_step = int(math.ceil((ct0 - 1e-6) / step_s))
            last_step = int(math.floor((ct1 - 1e-6) / step_s))
            for st_i in range(first_step, last_step + 1):
                bt = st_i * step_s
                if bt < ct0 - 1e-6 or bt >= ct1 - 1e-6:
                    continue
                a_deg = arp_degs[st_i % len(arp_degs)]
                oct_b = 4 if (is_high and (st_i % 4 >= 2)) else 3
                hz = _midi_to_hz(_degree_midi(root_semi, scale_iv, a_deg, base_octave=oct_b))
                accent = 1.15 if (st_i % subdiv == 0) else 0.82
                vel = float(np.clip((0.36 + 0.56 * energy) * accent, 0.20, 0.98))
                ring_s = min(eff_dur - bt, step_s * (2.4 if is_breath else 1.85))
                if ring_s <= 0.02:
                    continue
                plk = _synth_pluck_note(hz, ring_s, synth_sr, r, vel=vel, sparkle=max(0.0, energy - 0.45))
                pan_pos = 0.22 * math.sin(0.85 * st_i)
                _place_stereo(arp_bus, plk, int(round(bt * synth_sr)), gain=sec_amp * 0.88, pan=pan_pos)

                # 高潮段正拍叠加温暖定音鼓/低音大提琴拨奏根音重拍锁定节拍锚点
                if is_high and (st_i % subdiv == 0):
                    low_hz = _midi_to_hz(_degree_midi(root_semi, scale_iv, deg, base_octave=2))
                    low_hit = _synth_pluck_note(low_hz, min(eff_dur - bt, spb * 0.95), synth_sr, r, vel=0.90, sparkle=0.0)
                    _place_stereo(arp_bus, low_hit, int(round(bt * synth_sr)), gain=sec_amp * 0.72, pan=0.0)

        # 切镜前预示推浪与呼吸引子（Pre-Cut Anticipatory Riser / Pickup Swell）
        if s_idx > 0:
            prev_e = secs[s_idx - 1]['energy']
            delta_e = energy - prev_e
            lead_s = min(0.55, 0.45 * (secs[s_idx - 1]['t1'] - secs[s_idx - 1]['t0']), t0)
            if lead_s >= 0.14 and delta_e > 0.05:
                r_n = int(round(lead_s * synth_sr))
                r_i0 = max(0, int(round(t0 * synth_sr)) - r_n)
                r_m = int(round(t0 * synth_sr)) - r_i0
                if r_m > 16:
                    u_r = np.linspace(0.0, 1.0, r_m, dtype=np.float64)
                    swell_env = (u_r ** 2.1) * (1.0 - smoothstep(0.92, 1.0, u_r) * 0.25)
                    # 上行竖琴刮奏（Pickup Glissando）+ 柔和铜管/吊镲气息渐强
                    gliss_steps = 6 if delta_e >= 0.25 else 4
                    target_deg = degs[0]
                    for g_k in range(gliss_steps):
                        gt = (t0 - lead_s) + g_k * (0.85 * lead_s / gliss_steps)
                        g_hz = _midi_to_hz(_degree_midi(root_semi, scale_iv, target_deg - gliss_steps + g_k + 1, base_octave=4))
                        g_note = _synth_pluck_note(g_hz, min(eff_dur - gt, 0.55), synth_sr, r, vel=0.45 + 0.08 * g_k, sparkle=0.5)
                        _place_stereo(riser_bus, g_note, int(round(gt * synth_sr)), gain=0.42 + 0.45 * max(0.0, delta_e), pan=-0.20 + 0.08 * g_k)
                    shimmer_noise = r.standard_normal(r_m)
                    sos_bp = butter(2, [1200.0, 6800.0], 'band', fs=float(synth_sr), output='sos')
                    shimmer = sosfilt(sos_bp, shimmer_noise) * swell_env * (0.045 + 0.075 * max(0.0, delta_e))
                    _place_stereo(riser_bus, shimmer, r_i0, gain=1.0, pan=0.08)

    dry_mix = pad_bus + arp_bus + riser_bus

    # 温暖音乐厅早期反射与混响融合（高通 150 Hz 保持低频紧致，绝不糊低频，截断到精确样本数）
    ir = make_ir(rt=1.55, pre=0.018, er=8, seed=int(seed) + 7, length=1.8)
    src_hp = sosfilt(butter(2, 150.0, 'high', fs=float(synth_sr), output='sos'), dry_mix, axis=0)
    wet_l = fftconvolve(0.75 * src_hp[:, 0] + 0.25 * src_hp[:, 1], ir[:, 0])[:n_synth]
    wet_r = fftconvolve(0.75 * src_hp[:, 1] + 0.25 * src_hp[:, 0], ir[:, 1])[:n_synth]
    guide_st = dry_mix + 0.24 * np.stack([wet_l, wet_r], axis=1)

    # 清理次声波与直流分量
    guide_st = sosfilt(butter(2, 30.0, 'high', fs=float(synth_sr), output='sos'), guide_st, axis=0)
    guide_st = guide_st - np.mean(guide_st, axis=0, keepdims=True)

    n_out = max(2, int(round(eff_dur * sr_out)))
    if sr_out != synth_sr:
        guide_st = soxr.resample(guide_st, synth_sr, sr_out)
        if len(guide_st) < n_out:
            guide_st = np.vstack([guide_st, np.zeros((n_out - len(guide_st), 2), dtype=np.float64)])
        else:
            guide_st = guide_st[:n_out].copy()

    # 首尾平滑淡入淡出（10 ms 淡入 / 75 ms 淡出）并峰值归一至 -3.0 dBFS
    fin_s = min(0.010, 0.15 * eff_dur)
    fout_s = min(0.075, 0.20 * eff_dur)
    guide_st = fade(guide_st, fin=fin_s, fout=fout_s)
    guide_st[0] = 0.0
    guide_st[-1] = 0.0

    target_peak = float(undb(-3.0))
    cur_peak = float(np.max(np.abs(guide_st)))
    if cur_peak > 1e-12:
        guide_st = guide_st * (target_peak / cur_peak)
    guide_st = np.nan_to_num(guide_st, nan=0.0, posinf=0.0, neginf=0.0)
    guide_st[0] = 0.0
    guide_st[-1] = 0.0

    sec_metrics = []
    for sec in secs:
        a = max(0, min(n_out, int(round(sec['t0'] * sr_out))))
        b = max(a + 1, min(n_out, int(round(sec['t1'] * sr_out))))
        seg_rms = float(np.sqrt(np.mean(guide_st[a:b] ** 2) + 1e-24))
        sec_metrics.append({
            'id': sec['id'],
            't0': round(sec['t0'], 4),
            't1': round(sec['t1'], 4),
            'energy': sec['energy'],
            'mood': sec['mood'],
            'chord_deg': list(sec['chord_deg']),
            'rms_dbfs': round(20.0 * math.log10(max(seg_rms, 1e-12)), 2),
        })

    st_48k = guide_st if sr_out == SR else soxr.resample(guide_st, sr_out, SR)
    lufs_val = integrated(st_48k) if len(st_48k) >= int(0.4 * SR) else -math.inf
    final_peak_db = 20.0 * math.log10(max(float(np.max(np.abs(guide_st))), 1e-12))

    meta = {
        'dur': eff_dur,
        'fps': eff_fps,
        'sr': sr_out,
        'samples': n_out,
        'key': eff_key,
        'scale': eff_scale,
        'bpm': eff_bpm,
        'seed': int(seed),
        'peak_dbfs': round(final_peak_db, 2),
        'lufs': round(float(lufs_val), 2) if math.isfinite(lufs_val) else None,
        'sections': sec_metrics,
    }
    return guide_st, meta


def _fit_stereo_duration(arr: np.ndarray, n_target: int, sr: int) -> np.ndarray:
    """将立体声波形精裁或平滑余韵延展至精确 n_target 个样本，绝不产生拼接台阶爆音。"""
    x = np.asarray(arr, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    elif x.shape[1] == 1:
        x = np.concatenate([x, x], axis=1)
    elif x.shape[1] > 2:
        x = x[:, :2]
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)

    if len(x) == 0:
        return np.zeros((n_target, 2), dtype=np.float64)
    if len(x) >= n_target:
        return x[:n_target].copy()

    deficit = n_target - len(x)
    out = np.zeros((n_target, 2), dtype=np.float64)
    out[:len(x)] = x

    # 若返回音频略短于目标时长，从尾部取镜像余韵段做指数衰减平滑过渡，避免硬截断成零台阶
    tail_src_len = min(len(x), max(32, int(round(0.45 * sr))))
    if tail_src_len >= 16 and deficit > 0:
        pad_len = min(deficit, int(round(1.6 * sr)))
        mirror = x[len(x) - tail_src_len:][::-1]
        reps = int(math.ceil(pad_len / float(len(mirror))))
        tiled = np.tile(mirror, (reps, 1))[:pad_len]
        t_pad = np.linspace(0.0, 1.0, pad_len, dtype=np.float64)
        decay = np.exp(-3.8 * t_pad) * (0.5 * (1.0 + np.cos(math.pi * t_pad)))
        # 在拼接处做 12 ms 交叉淡化消除导数折角
        xf = min(int(round(0.012 * sr)), len(x) // 4, pad_len // 2)
        if xf > 2:
            u = np.linspace(0.0, 1.0, xf, dtype=np.float64)[:, None]
            out[len(x) - xf:len(x)] = out[len(x) - xf:len(x)] * (1.0 - 0.35 * u) + tiled[:xf] * (0.35 * u)
        out[len(x):len(x) + pad_len] = tiled * decay[:, None]
    return out


def _finalize_music_wave(arr: np.ndarray, n_target: int, sr: int) -> np.ndarray:
    """精配长度至 n_target，施加 15 ms 淡入 / 120 ms 淡出并确保首尾精确为 0.0、无满幅削波。"""
    y = _fit_stereo_duration(arr, n_target, sr)
    dur_s = n_target / float(sr)
    fin_s = min(0.015, 0.20 * dur_s)
    fout_s = min(0.120, 0.25 * dur_s)
    y = fade(y, fin=fin_s, fout=fout_s)
    ceil_lin = float(undb(-1.0))
    pk = float(np.max(np.abs(y))) if len(y) else 0.0
    if pk > ceil_lin:
        y = y * (ceil_lin / pk)
    if len(y) > 0:
        y[0] = 0.0
        y[-1] = 0.0
    return y


def _pcm16_digest(st: np.ndarray) -> str:
    q = np.clip(np.round(np.asarray(st, dtype=np.float64) * 32767.0), -32768.0, 32767.0).astype('<i2')
    return hashlib.sha256(q.tobytes()).hexdigest()


def _encode_wav_pcm16_bytes(st: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.asarray(st, dtype=np.float32), int(sr), format='WAV', subtype='PCM_16')
    return buf.getvalue()


def _write_wav_atomic(path: str, st: np.ndarray, sr: int) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.wav'
    try:
        sf.write(tmp, np.asarray(st, dtype=np.float64), int(sr), format='WAV', subtype='PCM_24')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _write_json_atomic(path: str, obj: dict) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f'{path}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.json'
    try:
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _copy_atomic(src: str, dst: str) -> None:
    if os.path.abspath(src) == os.path.abspath(dst):
        return
    parent = os.path.dirname(os.path.abspath(dst))
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f'{dst}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp'
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _measure_lufs(st: np.ndarray, sr: int) -> float | None:
    x48 = st if sr == SR else soxr.resample(st, sr, SR)
    if len(x48) < int(0.4 * SR):
        return None
    val = integrated(x48)
    return round(float(val), 2) if math.isfinite(val) else None


def _pick_ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return int(s.getsockname()[1])


@contextmanager
def _resolve_acestep_base_url(endpoint: str | None, ssh_host: str | None, remote_port: int = 8001, connect_timeout_s: float = 12.0):
    """按优先级解析 ACE-Step 1.5 HTTP 地址：endpoint 参数 → BEIMING_ACESTEP_URL → SSH 临时本地端口转发。"""
    env_url = (os.environ.get('BEIMING_ACESTEP_URL') or '').strip()
    chosen = (endpoint or '').strip() or env_url
    if chosen:
        parsed = urllib.parse.urlparse(chosen)
        if parsed.scheme not in ('http', 'https') or not parsed.netloc:
            raise CliError(
                'usage.bad-value',
                f'ACE-Step 服务地址格式不合法：{chosen!r}',
                hint='应以 http:// 或 https:// 开头，例如 https://example.invalid',
            )
        yield chosen.rstrip('/'), False
        return

    host = (ssh_host or '').strip()
    if not host:
        raise CliError(
            'env.music-endpoint',
            '未配置 ACE-Step 1.5 服务端地址（既未传 --endpoint / --ssh，也未设 BEIMING_ACESTEP_URL）',
            hint='传 --endpoint <URL> 或 --ssh <ssh-alias>，或设环境变量 BEIMING_ACESTEP_URL；动态预演与离线测试可加 --provider guide',
            exit_code=3,
        )

    if host.startswith('-') or any(c.isspace() for c in host):
        raise CliError(
            'usage.bad-value',
            f'--ssh 主机名不合法：{host!r}',
            hint='应为 ssh 别名或 user@host，不能以 - 开头、不能含空白（否则会被 ssh 当成选项）',
        )

    if not shutil.which('ssh'):
        raise CliError(
            'env.music-ssh',
            'PATH 里找不到 ssh 客户端，无法建立远端 ACE-Step 隧道',
            hint='安装 OpenSSH 客户端，或直接传 --endpoint <URL>',
            exit_code=3,
        )

    local_port = _pick_ephemeral_port()
    cmd = [
        'ssh',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=10',
        '-N',
        '-L', f'127.0.0.1:{local_port}:127.0.0.1:{int(remote_port)}',
        '--',
        host,
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + max(1.0, float(connect_timeout_s))
        ready = False
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                err_txt = ''
                if proc.stderr is not None:
                    try:
                        err_txt = proc.stderr.read().decode('utf-8', errors='replace').strip()
                    except OSError:
                        err_txt = ''
                raise CliError(
                    'env.music-ssh',
                    f'SSH 端口转发启动失败（退出码 {proc.returncode}）：{err_txt or host}',
                    hint='检查免密 SSH 配置与远端 ACE-Step 端口是否已监听，或改用 --provider guide',
                    exit_code=3,
                )
            try:
                with socket.create_connection(('127.0.0.1', local_port), timeout=0.25):
                    ready = True
                    break
            except OSError:
                time.sleep(0.08)

        if not ready:
            raise CliError(
                'env.music-ssh',
                f'等待 SSH 本地转发端口就绪超时（{connect_timeout_s:.1f}s）：{host}',
                hint='确认主机在线且免密登录正常，或改用 --provider guide',
                exit_code=3,
            )

        yield f'http://127.0.0.1:{local_port}', True
    finally:
        try:
            _env.kill_tree(proc, grace=2.0)
        finally:
            if proc.stderr is not None:
                try:
                    proc.stderr.close()
                except OSError:
                    pass


def _build_http_opener(url: str):
    host = (urllib.parse.urlparse(url).hostname or '').lower()
    if host in ('127.0.0.1', 'localhost', '::1'):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()


def _http_request(url: str, *, method: str = 'GET', body: bytes | None = None,
                  headers: dict | None = None, timeout_s: float = 30.0) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    opener = _build_http_opener(url)
    with opener.open(req, timeout=max(0.5, float(timeout_s))) as resp:
        status = int(getattr(resp, 'status', 200))
        raw = resp.read()
        hdrs = dict(resp.headers.items())
        return status, raw, hdrs


def _encode_multipart(fields: dict[str, str], files: list[tuple[str, str, str, bytes]]) -> tuple[bytes, str]:
    boundary = f'----BeimingAceStepBoundary{uuid.uuid4().hex}'
    chunks: list[bytes] = []
    for k, v in fields.items():
        chunks.append(f'--{boundary}\r\n'.encode('utf-8'))
        chunks.append(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode('utf-8'))
        chunks.append(str(v).encode('utf-8'))
        chunks.append(b'\r\n')
    for field_name, filename, content_type, payload in files:
        chunks.append(f'--{boundary}\r\n'.encode('utf-8'))
        chunks.append(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode('utf-8')
        )
        chunks.append(f'Content-Type: {content_type}\r\n\r\n'.encode('utf-8'))
        chunks.append(payload)
        chunks.append(b'\r\n')
    chunks.append(f'--{boundary}--\r\n'.encode('utf-8'))
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


def _unwrap_payload(doc):
    if isinstance(doc, dict) and 'data' in doc and doc['data'] is not None:
        return doc['data']
    return doc


def _extract_task_entry(doc, task_id: str) -> dict | None:
    inner = _unwrap_payload(doc)
    if isinstance(inner, list):
        for item in inner:
            if isinstance(item, dict) and (not item.get('task_id') or str(item.get('task_id')) == str(task_id)):
                return item
        return inner[0] if (inner and isinstance(inner[0], dict)) else None
    if isinstance(inner, dict):
        if isinstance(inner.get('tasks'), list) and inner['tasks']:
            return inner['tasks'][0]
        return inner
    return None


def _extract_audio_ref(entry: dict) -> str | None:
    res = entry.get('result')
    if isinstance(res, str):
        s = res.strip()
        if s.startswith(('[', '{')):
            try:
                res = json.loads(s)
            except ValueError:
                pass
    candidates: list[dict] = []
    if isinstance(res, list):
        candidates.extend(x for x in res if isinstance(x, dict))
    elif isinstance(res, dict):
        candidates.append(res)
    candidates.append(entry)

    for obj in candidates:
        for key in ('file', 'url', 'audio_url', 'audio', 'path', 'audio_path', 'output'):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    if isinstance(res, str) and res.strip():
        return res.strip()
    return None


def _download_acestep_audio(base_url: str, audio_ref: str, via_tunnel: bool, timeout_s: float) -> bytes:
    urls_to_try: list[str] = []
    if audio_ref.startswith(('http://', 'https://')):
        if via_tunnel:
            parsed = urllib.parse.urlparse(audio_ref)
            rebound = f"{base_url}{parsed.path}" + (f"?{parsed.query}" if parsed.query else '')
            urls_to_try.append(rebound)
        urls_to_try.append(audio_ref)
    elif audio_ref.startswith('/v1/'):
        urls_to_try.append(f'{base_url}{audio_ref}')
    elif audio_ref.startswith('/'):
        # 既可能是服务端静态路由（/audio/x.wav），也可能是远端磁盘绝对路径（需经 /v1/audio?path=... 拉取）
        qpath = urllib.parse.quote(audio_ref, safe='')
        urls_to_try.append(f'{base_url}/v1/audio?path={qpath}')
        urls_to_try.append(f'{base_url}{audio_ref}')
    else:
        qpath = urllib.parse.quote(audio_ref, safe='')
        urls_to_try.append(f'{base_url}/v1/audio?path={qpath}')
        urls_to_try.append(f'{base_url}/{audio_ref.lstrip("/")}')

    last_err = None
    for u in dict.fromkeys(urls_to_try):
        try:
            status, raw, _ = _http_request(u, method='GET', timeout_s=timeout_s)
            if 200 <= status < 300 and raw:
                return raw
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
    raise CliError(
        'failure.acestep-download',
        f'下载 ACE-Step 生成音频失败（引用：{audio_ref!r}）：{last_err or "空响应"}',
        hint='检查服务端 /v1/audio 路由输出是否正常',
    )


def _call_acestep_cover_api(
    base_url: str,
    via_tunnel: bool,
    *,
    guide_wav_bytes: bytes,
    prompt: str,
    lyrics: str,
    dur: float,
    cover_strength: float,
    steps: int,
    guidance_scale: float,
    seed: int,
    timeout_s: float,
) -> bytes:
    fields = {
        'task_type': 'cover',
        'prompt': str(prompt),
        'lyrics': str(lyrics or '[inst]'),
        'audio_duration': f'{float(dur):.4f}',
        'audio_cover_strength': f'{float(cover_strength):.4f}',
        'inference_steps': str(int(steps)),
        'guidance_scale': f'{float(guidance_scale):.3f}',
        'seed': str(int(seed)),
        'use_random_seed': 'false',
        'thinking': 'false',
        'audio_format': 'wav',
    }
    body, ctype = _encode_multipart(
        fields,
        [('src_audio', 'guide.wav', 'audio/wav', guide_wav_bytes)],
    )
    deadline = time.monotonic() + max(2.0, float(timeout_s))

    try:
        _, raw_rel, _ = _http_request(
            f'{base_url}/release_task',
            method='POST',
            body=body,
            headers={'Content-Type': ctype, 'Accept': 'application/json'},
            timeout_s=min(60.0, max(5.0, deadline - time.monotonic())),
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CliError(
            'env.music-unreachable',
            f'连接 ACE-Step 1.5 /release_task 失败：{exc}',
            hint='先跑 probe 子命令确认服务端在线，或临时加 --provider guide 离线生成导引轨',
            exit_code=3,
        ) from None

    try:
        rel_doc = json.loads(raw_rel.decode('utf-8'))
    except ValueError as exc:
        raise CliError('failure.acestep-submit', f'/release_task 返回非 JSON 响应：{exc}') from None

    rel_inner = _unwrap_payload(rel_doc)
    task_id = None
    if isinstance(rel_inner, dict):
        task_id = rel_inner.get('task_id') or rel_inner.get('id')
    if not task_id and isinstance(rel_doc, dict):
        task_id = rel_doc.get('task_id') or rel_doc.get('id')
    if not task_id:
        err_msg = rel_doc.get('error') if isinstance(rel_doc, dict) else rel_doc
        raise CliError('failure.acestep-submit', f'/release_task 未返回 task_id：{err_msg}')

    poll_payload = json.dumps({'task_id_list': [str(task_id)]}).encode('utf-8')
    poll_idx = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise CliError(
                'timeout.acestep',
                f'等待 ACE-Step 1.5 Cover 推理结果超时（>{timeout_s:.1f}s，task_id={task_id}）',
                hint='调大 --timeout 或减小 --steps',
            )
        try:
            _, raw_q, _ = _http_request(
                f'{base_url}/query_result',
                method='POST',
                body=poll_payload,
                headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
                timeout_s=min(30.0, max(1.0, remaining)),
            )
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CliError('failure.acestep-poll', f'轮询 /query_result 失败：{exc}') from None

        try:
            q_doc = json.loads(raw_q.decode('utf-8'))
        except ValueError as exc:
            raise CliError('failure.acestep-poll', f'/query_result 返回非 JSON 响应：{exc}') from None

        entry = _extract_task_entry(q_doc, str(task_id))
        if entry is not None:
            st_val = entry.get('status')
            if st_val in (1, '1', 'succeeded', 'completed', 'done', 'success'):
                audio_ref = _extract_audio_ref(entry)
                if not audio_ref:
                    raise CliError('failure.acestep-result', f'任务 {task_id} 已完成（status=1），但响应中缺少音频地址字段')
                return _download_acestep_audio(
                    base_url,
                    audio_ref,
                    via_tunnel=via_tunnel,
                    timeout_s=min(60.0, max(5.0, deadline - time.monotonic())),
                )
            if st_val in (2, -1, '2', '-1', 'failed', 'error', 'cancelled'):
                reason = entry.get('error') or entry.get('progress_text') or entry.get('result') or st_val
                raise CliError('failure.acestep-task', f'ACE-Step 1.5 推理任务失败（task_id={task_id}）：{reason}')

        sleep_s = min(0.8, 0.04 * (1.45 ** min(poll_idx, 8)))
        poll_idx += 1
        time.sleep(min(sleep_s, max(0.01, deadline - time.monotonic())))


def generate_cover(
    guide_wav_or_arr,
    *,
    prompt: str,
    lyrics: str = '[inst]',
    dur: float = None,
    endpoint: str = None,
    ssh_host: str = None,
    remote_port: int = 8001,
    cover_strength: float = 0.45,
    steps: int = 8,
    guidance_scale: float = 4.5,
    seed: int = 42,
    provider: str = 'acestep',
    cache_dir: str = None,
    out_wav: str = None,
    offline: bool = False,
    timeout_s: float = 300.0,
    sr: int = 48000,
) -> dict:
    """将导引音轨送入 ACE-Step 1.5 Cover 模式（或离线确定性 guide 模式），输出精确 N(dur) 立体声 PCM_24 配乐。"""
    prov = (provider or 'acestep').strip().lower()
    if prov not in ('acestep', 'guide'):
        raise CliError(
            'usage.bad-value',
            f'不认识的配乐生成服务 {provider!r}',
            hint='可选：acestep（ACE-Step 1.5 Cover 模式）或 guide（离线确定性导引轨）',
        )
    sr_out = int(sr)
    if sr_out < 8000:
        raise CliError('usage.bad-value', f'采样率 sr 不合法：{sr_out!r}')
    if not (0.0 <= float(cover_strength) <= 1.0):
        raise CliError('usage.bad-value', f'cover_strength 必须在 0..1 之间，收到 {cover_strength!r}')
    if int(steps) < 1:
        raise CliError('usage.bad-value', f'steps 必须 >= 1，收到 {steps!r}')

    if isinstance(guide_wav_or_arr, (str, os.PathLike)):
        g_path = str(guide_wav_or_arr)
        if not os.path.isfile(g_path):
            raise CliError(
                'env.guide-missing',
                f'找不到导引音轨文件：{rel(g_path)}',
                hint='先运行 guide 子命令生成导引轨，或检查 --guide 路径',
                exit_code=3,
            )
        try:
            g_arr, g_sr = sf.read(g_path, always_2d=True, dtype='float64')
        except Exception as exc:
            raise CliError('failure.guide-read', f'读取导引音轨失败（{rel(g_path)}）：{exc}') from None
    elif isinstance(guide_wav_or_arr, np.ndarray):
        g_arr = np.asarray(guide_wav_or_arr, dtype=np.float64)
        if g_arr.ndim == 1:
            g_arr = np.stack([g_arr, g_arr], axis=1)
        g_sr = sr_out
    else:
        raise CliError('usage.bad-value', f'guide_wav_or_arr 需要文件路径或 numpy 数组，收到 {type(guide_wav_or_arr).__name__}')

    if g_arr.shape[1] == 1:
        g_arr = np.concatenate([g_arr, g_arr], axis=1)
    elif g_arr.shape[1] > 2:
        g_arr = g_arr[:, :2]
    if int(g_sr) != sr_out and len(g_arr) > 0:
        g_arr = soxr.resample(g_arr, int(g_sr), sr_out)

    eff_dur = float(dur) if dur is not None else (len(g_arr) / float(sr_out))
    if eff_dur <= 0.0:
        raise CliError('usage.bad-value', f'配乐时长 dur 必须为正数，收到 {eff_dur!r}')
    n_target = max(2, int(round(eff_dur * sr_out)))

    guide_fitted = _fit_stereo_duration(g_arr, n_target, sr_out)
    guide_digest = _pcm16_digest(guide_fitted)
    norm_prompt = str(prompt or '').strip()
    norm_lyrics = str(lyrics or '[inst]').strip() or '[inst]'

    if prov == 'guide':
        guide_final = _finalize_music_wave(guide_fitted, n_target, sr_out)
        guide_key = hashlib.sha256(
            json.dumps([guide_digest, round(eff_dur, 4), sr_out, 'guide'], separators=(',', ':')).encode('utf-8')
        ).hexdigest()
        target_out = os.path.abspath(out_wav) if out_wav else None
        if target_out:
            _write_wav_atomic(target_out, guide_final, sr_out)
        return {
            'path': target_out,
            'cache': 'guide',
            'key': guide_key,
            'duration': eff_dur,
            'samples': n_target,
            'lufs': _measure_lufs(guide_final, sr_out),
            'aigc': dict(AIGC_GUIDE),
        }

    # provider == 'acestep'：计算确定性缓存键
    key_tuple = [
        guide_digest,
        norm_prompt,
        norm_lyrics,
        round(float(cover_strength), 4),
        int(steps),
        round(float(guidance_scale), 3),
        int(seed),
        round(eff_dur, 4),
        'acestep-1.5',
    ]
    if sr_out != SR:
        key_tuple.append(sr_out)
    cache_key = hashlib.sha256(
        json.dumps(key_tuple, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ).hexdigest()

    cdir = os.path.abspath(cache_dir) if cache_dir else None
    cache_wav = os.path.join(cdir, f'{cache_key}.wav') if cdir else None
    cache_meta = os.path.join(cdir, f'{cache_key}.json') if cdir else None
    target_out = os.path.abspath(out_wav) if out_wav else None

    # 缓存命中判定：校验存在性、样本数、采样率、声道数与元数据完整性
    if cache_wav and cache_meta and os.path.isfile(cache_wav) and os.path.isfile(cache_meta):
        try:
            info = sf.info(cache_wav)
            with open(cache_meta, encoding='utf-8') as f:
                meta_doc = json.load(f)
            if info.frames == n_target and info.samplerate == sr_out and info.channels == 2:
                if target_out:
                    _copy_atomic(cache_wav, target_out)
                lufs_cached = meta_doc.get('lufs')
                if lufs_cached is None:
                    cached_st, _ = sf.read(cache_wav, always_2d=True, dtype='float64')
                    lufs_cached = _measure_lufs(cached_st, sr_out)
                return {
                    'path': target_out or cache_wav,
                    'cache': 'hit',
                    'key': cache_key,
                    'duration': eff_dur,
                    'samples': n_target,
                    'lufs': lufs_cached,
                    'aigc': dict(meta_doc.get('aigc') or AIGC_ACESTEP),
                }
        except Exception:
            # 缓存损坏时按未命中处理（离线模式报错，在线模式重算覆盖）
            pass

    if offline:
        raise CliError(
            'env.music-offline',
            f'离线模式（--offline）下配乐缓存未命中：{cache_key[:12]}',
            hint='去掉 --offline 连接 ACE-Step 1.5 生成一次写入缓存，或临时改用 --provider guide 合成导引轨',
            exit_code=3,
        )

    guide_wav_bytes = _encode_wav_pcm16_bytes(guide_fitted, sr_out)
    with _resolve_acestep_base_url(
        endpoint,
        ssh_host,
        remote_port=int(remote_port),
        connect_timeout_s=min(15.0, max(2.0, float(timeout_s))),
    ) as (base_url, via_tunnel):
        gen_bytes = _call_acestep_cover_api(
            base_url,
            via_tunnel,
            guide_wav_bytes=guide_wav_bytes,
            prompt=norm_prompt,
            lyrics=norm_lyrics,
            dur=eff_dur,
            cover_strength=float(cover_strength),
            steps=int(steps),
            guidance_scale=float(guidance_scale),
            seed=int(seed),
            timeout_s=float(timeout_s),
        )

    try:
        raw_gen, gen_sr = sf.read(io.BytesIO(gen_bytes), always_2d=True, dtype='float64')
    except Exception as exc:
        raise CliError('failure.acestep-decode', f'解码 ACE-Step 返回音频失败：{exc}') from None

    if raw_gen.shape[1] == 1:
        raw_gen = np.concatenate([raw_gen, raw_gen], axis=1)
    elif raw_gen.shape[1] > 2:
        raw_gen = raw_gen[:, :2]
    if int(gen_sr) != sr_out and len(raw_gen) > 0:
        raw_gen = soxr.resample(raw_gen, int(gen_sr), sr_out)

    final_st = _finalize_music_wave(raw_gen, n_target, sr_out)
    lufs_val = _measure_lufs(final_st, sr_out)

    if cache_wav and cache_meta:
        _write_wav_atomic(cache_wav, final_st, sr_out)
        wav_sha = sha256_file(cache_wav)
        _write_json_atomic(cache_meta, {
            'schema': CACHE_SCHEMA,
            'key': cache_key,
            'sha256': wav_sha,
            'sr': sr_out,
            'samples': n_target,
            'duration': eff_dur,
            'lufs': lufs_val,
            'params': {
                'guide_pcm16_sha256': guide_digest,
                'prompt': norm_prompt,
                'lyrics': norm_lyrics,
                'cover_strength': round(float(cover_strength), 4),
                'steps': int(steps),
                'guidance_scale': round(float(guidance_scale), 3),
                'seed': int(seed),
                'dur': round(eff_dur, 4),
                'model': 'acestep-1.5',
            },
            'aigc': dict(AIGC_ACESTEP),
        })
        if target_out:
            _copy_atomic(cache_wav, target_out)
        final_path = target_out or cache_wav
    else:
        if target_out:
            _write_wav_atomic(target_out, final_st, sr_out)
        final_path = target_out

    return {
        'path': final_path,
        'cache': 'miss',
        'key': cache_key,
        'duration': eff_dur,
        'samples': n_target,
        'lufs': lufs_val,
        'aigc': dict(AIGC_ACESTEP),
    }


def probe_endpoint(*, endpoint: str = None, ssh_host: str = None, remote_port: int = 8001, timeout_s: float = 10.0) -> dict:
    """探测 ACE-Step 1.5 服务端（/health 或 /v1/stats）是否在线可达；不可达时抛退出码 3 的 CliError。"""
    t_budget = max(1.0, float(timeout_s))
    with _resolve_acestep_base_url(
        endpoint,
        ssh_host,
        remote_port=int(remote_port),
        connect_timeout_s=min(12.0, t_budget),
    ) as (base_url, via_tunnel):
        last_err = None
        for probe_path in ('/health', '/v1/stats'):
            try:
                status, raw, _ = _http_request(
                    f'{base_url}{probe_path}',
                    method='GET',
                    headers={'Accept': 'application/json'},
                    timeout_s=min(8.0, t_budget),
                )
                if 200 <= status < 300:
                    info = None
                    try:
                        info = _unwrap_payload(json.loads(raw.decode('utf-8')))
                    except ValueError:
                        info = raw.decode('utf-8', errors='replace').strip()[:200]
                    return {
                        'online': True,
                        'probePath': probe_path,
                        'status': status,
                        'viaSsh': via_tunnel,
                        'info': info,
                    }
                last_err = f'HTTP {status}'
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_err = str(exc)

    raise CliError(
        'env.music-unreachable',
        f'ACE-Step 1.5 服务不可达（已探测 /health 与 /v1/stats）：{last_err}',
        hint='确认 ACE-Step 1.5 API 服务已启动，或改用 --provider guide 走离线导引轨模式',
        exit_code=3,
    )


def _default_prompt_from_plan(plan: dict) -> str:
    key = plan.get('key', 'D')
    scale = plan.get('scale', 'major')
    bpm = int(round(float(plan.get('bpm', 96.0))))
    moods = ' -> '.join(dict.fromkeys(s['mood'] for s in (plan.get('sections') or [])))
    return (
        f'cinematic orchestral soundtrack in {key} {scale}, {bpm} BPM, '
        f'warm cello and string ensemble, concert harp arpeggios, expressive narrative arc ({moods}) '
        f'building to soaring finale, high-fidelity studio orchestral recording, instrumental only, no vocals'
    )


def make_parser() -> ArgumentParser:
    p = ArgumentParser(
        prog='python -m engine.audio.music_gen',
        description=(
            '情绪导引乐谱与 ACE-Step 1.5 Cover 配乐生成：'
            'guide 合成程序化导引轨；build 生成 Cover 配乐（或 guide 离线确定性轨）；probe 探测服务连通性。'
        ),
    )
    p.add_argument('action', choices=['guide', 'build', 'probe'], help='guide 合成导引轨；build 生成配乐；probe 探测 ACE-Step 连通性')
    p.add_argument('film', nargs='?', help='作品目录或 film.json（probe 可省略；build 给了 --guide 时也可省略）')
    p.add_argument('--out', help='输出 WAV 路径（默认 <作品>/out/music/guide.wav 或 music.wav）')
    p.add_argument('--key', help='调性主音（默认读作品配置，缺省 D）')
    p.add_argument('--scale', help='音阶类型（major / minor / dorian / mixolydian / lydian / pentatonic / minor-pentatonic，默认 major）')
    p.add_argument('--bpm', type=float, help='节拍速度 BPM（默认读作品配置，缺省 96）')
    p.add_argument('--dur', type=float, help='显式指定配乐时长（秒；没有 film.json 时使用）')
    p.add_argument('--prompt', help='ACE-Step 1.5 音乐风格与配器提示词（省略时按作品调性与叙事段落自动生成纯器乐提示词）')
    p.add_argument('--lyrics', default='[inst]', help='歌词或纯器乐标记（默认 [inst]）')
    p.add_argument('--guide', help='build 使用的外部导引轨 WAV（省略时自动从 film.json 合成导引轨）')
    p.add_argument('--cache', help='ACE-Step 缓存目录（默认 <作品>/out/cache/music）')
    p.add_argument('--provider', choices=['acestep', 'guide'], default='acestep', help='生成服务：acestep（ACE-Step 1.5 Cover）或 guide（离线确定性导引轨）')
    p.add_argument('--endpoint', help='ACE-Step 1.5 HTTP 服务地址（例：https://example.invalid；未设时读 BEIMING_ACESTEP_URL）')
    p.add_argument('--ssh', help='SSH 免密主机别名（例：<ssh-alias>；自动建立临时本地端口转发并在退出时清理）')
    p.add_argument('--remote-port', type=int, default=8001, help='SSH 转发的远端 ACE-Step 端口（默认 8001）')
    p.add_argument('--cover-strength', type=float, default=0.45, help='Cover 导引强度 0..1（默认 0.45）')
    p.add_argument('--steps', type=int, default=8, help='扩散推理步数（默认 8）')
    p.add_argument('--guidance-scale', type=float, default=4.5, help='CFG 引导系数（默认 4.5）')
    p.add_argument('--seed', type=int, default=42, help='确定性随机种子（默认 42）')
    p.add_argument('--timeout', type=float, default=300.0, help='网络探测或生成超时秒数（默认 300）')
    p.add_argument('--offline', action='store_true', help='只读本地缓存（缓存未命中时退出码 3，不发起网络连接）')
    return p


def _base_film_dir(film_arg: str | None) -> str | None:
    if not film_arg:
        return None
    p = os.path.abspath(film_arg)
    return p if os.path.isdir(p) else os.path.dirname(p)


def main(args, ctx):
    if args.action == 'probe':
        t_probe = args.timeout if args.timeout != 300.0 else 10.0
        res = probe_endpoint(
            endpoint=args.endpoint,
            ssh_host=args.ssh,
            remote_port=args.remote_port,
            timeout_s=t_probe,
        )
        ctx.out(f"ACE-Step 1.5 在线可达（{res['probePath']} → HTTP {res['status']}）")
        return {'data': res}

    if args.action == 'guide':
        if not args.film and args.dur is None:
            raise CliError(
                'usage.missing-argument',
                'guide 需要提供作品目录（或 film.json），或显式指定 --dur <秒>',
                hint='例：node tools/audio/music.mjs guide films/dawn',
            )
        if args.film:
            plan = plan_sections_from_film(args.film)
        else:
            plan = {'dur': float(args.dur), 'fps': 24, 'key': args.key or 'D', 'scale': args.scale or 'major', 'bpm': args.bpm or 96.0, 'sections': []}

        guide_st, meta = build_guide_score(
            plan,
            dur=args.dur if args.dur is not None else plan['dur'],
            fps=plan['fps'],
            key=args.key or plan['key'],
            scale=args.scale or plan['scale'],
            bpm=args.bpm if args.bpm is not None else plan['bpm'],
            sr=SR,
            seed=args.seed,
        )
        fdir = _base_film_dir(args.film)
        out_path = os.path.abspath(args.out or (os.path.join(fdir, 'out', 'music', 'guide.wav') if fdir else os.path.join('out', 'music', 'guide.wav')))
        _write_wav_atomic(out_path, guide_st, SR)
        wav_sha = sha256_file(out_path)
        ctx.out(
            f"导引乐谱已生成：{rel(out_path)}（{meta['dur']:.3f}s，{meta['samples']} 样本，{meta['key']} {meta['scale']}，"
            f"{meta['bpm']:.0f} BPM，{len(meta['sections'])} 段）"
        )
        data = dict(meta, path=rel(out_path))
        return {
            'data': data,
            'outputs': [{'path': rel(out_path), 'sha256': wav_sha, 'kind': 'audio'}],
        }

    # action == 'build'
    if not args.film and not args.guide:
        raise CliError(
            'usage.missing-argument',
            'build 需要提供作品目录（或 film.json），或传 --guide <导引轨.wav>',
            hint='例：node tools/audio/music.mjs build films/dawn --provider guide',
        )

    plan = None
    music_cfg = {}
    if args.film:
        _, music_cfg = _load_film_and_music_cfg(args.film)
        plan = plan_sections_from_film(args.film)

    fdir = _base_film_dir(args.film)
    out_path = os.path.abspath(args.out or (os.path.join(fdir, 'out', 'music', 'music.wav') if fdir else os.path.join('out', 'music', 'music.wav')))
    cache_dir = os.path.abspath(args.cache or (os.path.join(fdir, 'out', 'cache', 'music') if fdir else os.path.join('out', 'cache', 'music')))

    outputs = []
    guide_meta = None
    if args.guide:
        guide_src = args.guide
        target_dur = args.dur if args.dur is not None else (plan['dur'] if plan else None)
    else:
        guide_st, guide_meta = build_guide_score(
            plan,
            dur=args.dur if args.dur is not None else plan['dur'],
            fps=plan['fps'],
            key=args.key or plan['key'],
            scale=args.scale or plan['scale'],
            bpm=args.bpm if args.bpm is not None else plan['bpm'],
            sr=SR,
            seed=args.seed,
        )
        guide_out = os.path.join(os.path.dirname(out_path), 'guide.wav')
        if os.path.abspath(guide_out) != out_path:
            _write_wav_atomic(guide_out, guide_st, SR)
            outputs.append({'path': rel(guide_out), 'sha256': sha256_file(guide_out), 'kind': 'guide'})
        guide_src = guide_st
        target_dur = guide_meta['dur']

    eff_prompt = args.prompt or music_cfg.get('prompt') or (_default_prompt_from_plan(guide_meta or plan) if (guide_meta or plan) else 'cinematic instrumental soundtrack, warm strings and harp, no vocals')
    eff_lyrics = args.lyrics if args.lyrics != '[inst]' or not music_cfg.get('lyrics') else str(music_cfg['lyrics'])

    res = generate_cover(
        guide_src,
        prompt=eff_prompt,
        lyrics=eff_lyrics,
        dur=target_dur,
        endpoint=args.endpoint,
        ssh_host=args.ssh,
        remote_port=args.remote_port,
        cover_strength=args.cover_strength,
        steps=args.steps,
        guidance_scale=args.guidance_scale,
        seed=args.seed,
        provider=args.provider,
        cache_dir=cache_dir,
        out_wav=out_path,
        offline=args.offline,
        timeout_s=args.timeout,
        sr=SR,
    )
    outputs.insert(0, {'path': rel(out_path), 'sha256': sha256_file(out_path), 'kind': 'audio'})
    ctx.out(
        f"配乐已生成：{rel(out_path)}（服务={args.provider}，缓存={res['cache']}，"
        f"{res['duration']:.3f}s，{res['samples']} 样本，LUFS={res['lufs']}）"
    )
    data = dict(res, path=rel(out_path), provider=args.provider)
    if guide_meta is not None:
        data['sections'] = guide_meta['sections']
    return {'data': data, 'outputs': outputs}


if __name__ == '__main__':
    sys.exit(run(main, make_parser(), command='audio:music'))
