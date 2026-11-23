# -*- coding: utf-8 -*-
"""北冥引擎 · 情绪导引乐谱与 ACE-Step 1.5 / Suno v6 Cover 配乐生成（python -m engine.audio.music_gen，Node 入口 tools/audio/music.mjs）。

为什么采用「程序化导引轨（Guide Score）+ Cover 模式（ACE-Step 1.5 / Suno v6）」双层架构：
  纯文生音乐（Text-to-Music）容易在中段断片或结尾提前塌陷；先依据 film.json 的镜头切点与事件帧合成一条精确对齐画面时间轴的
  48 kHz 立体声导引乐谱（guide.wav：大提琴/弦乐温暖和声铺底 + 锁拍竖琴分解琶音 + 切镜前呼吸渐强引子 + 终章高八度辉煌抬升），
  再送入 ACE-Step 1.5 Cover 模式（task_type='cover', src_audio, audio_cover_strength）或本地 Magpie Suno MCP（Suno v6 Cover），
  即可把和声换挡、切镜推浪、留白呼吸与终章高潮牢牢锁死在影片的精确整数帧时间轴上，同时支持 --provider guide 纯本机确定性预演。

公开接口：
  plan_sections_from_film(film_or_dir) -> dict
      读取 film.json（及可选 music.json / audio.music 配置），从镜头表与事件表推导叙事配乐分段：
      {'dur', 'fps', 'key', 'scale', 'bpm', 'sections': [{'id', 't0', 't1', 'energy', 'mood', 'chord_deg'}]}
  build_guide_score(spec_or_sections, *, dur=None, fps=24, key='D', scale='major', bpm=96.0, style=None,
                    prompt='', world=None, events=None, midi_out=None, pad_tail_s=0.0, sr=48000, seed=42) -> (guide_st, meta_dict)
      调用 engine.audio.composer（功能/调式和声 + Viterbi 四声部最小运动连接 + 单一 4–6 音核心动机变形 + 挂留呼吸与弱起引子）
      确定性合成 100% 440Hz 标准音高立体声导引配乐（及可选 SMF Type-1 .mid），峰值归一至 -3.0 dBFS，首尾严格归零无爆音
  align_cover_pitch_locked(cover_st, guide_st, *, sr=48000, max_shift_ms=140.0, allow_uniform_stretch=True, max_stretch_pct=2.5) -> (aligned_st, info_dict)
      零跑调（0.0 cents）Cover 拍点对齐：严禁非保调变速重采样，仅做样本级恒定偏移校正或立体声锁相 STFT 相位声码器均匀微伸缩
  generate_cover(guide_wav_or_arr, *, prompt, lyrics='[inst]', dur=None, endpoint=None, ssh_host=None, remote_port=8001,
                 cover_strength=0.45, steps=8, guidance_scale=4.5, seed=42, provider='acestep', model='v6',
                 negative_style=None, prefer_wav_download=False, align_guide=True, pad_tail_s=0.0,
                 cache_dir=None, out_wav=None, offline=False, timeout_s=300.0, sr=48000) -> dict
      调用 ACE-Step 1.5 HTTP API、本地 Magpie Suno MCP（Suno v6 Cover）或 guide 离线确定性模式，
      按输入键 sha256 读写磁盘缓存，零跑调对齐并精裁至精确 N(dur) 立体声样本（15 ms 淡入 / 120 ms 淡出，PCM_24），附带 D11 AIGC 标识元数据
  probe_endpoint(*, endpoint=None, ssh_host=None, remote_port=8001, provider='acestep', timeout_s=10.0) -> dict
      探测 ACE-Step 1.5 HTTP 服务或 Suno MCP（initialize + account-usage）连通性与配额

命令行：
  python -m engine.audio.music_gen guide [film] [--out <guide.wav>] [--key D] [--scale major] [--bpm 96] [--seed 42]
  python -m engine.audio.music_gen build [film] [--prompt <str>] [--lyrics <str>] [--guide <wav>] [--out <music.wav>]
      [--cache <dir>] [--provider acestep|suno|guide] [--model v6] [--negative-style <str>] [--endpoint <url>]
      [--ssh <ssh-alias>] [--remote-port 8001] [--cover-strength 0.45] [--steps 8] [--guidance-scale 4.5]
      [--seed 42] [--timeout 300] [--offline]
  python -m engine.audio.music_gen probe [--provider acestep|suno] [--endpoint <url>] [--ssh <ssh-alias>] [--remote-port 8001] [--timeout 10]
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
from . import composer as COMP
from .dsp import SR, fade, rng, undb
from . import filmspec as FS
from .meter import integrated

__all__ = [
    'SCALES',
    'NOTE_OFFSETS',
    'COMPOSER_STYLES',
    'DEFAULT_SUNO_MCP_URL',
    'AIGC_ACESTEP',
    'AIGC_SUNO',
    'AIGC_GUIDE',
    'plan_sections_from_film',
    'build_guide_score',
    'align_cover_pitch_locked',
    'generate_cover',
    'probe_endpoint',
    'make_parser',
    'main',
]

COMPOSER_STYLES = COMP.COMPOSER_STYLES

CACHE_SCHEMA = 'beiming.music-cache/1'

DEFAULT_SUNO_MCP_URL = 'http://127.0.0.1:3425/mcp/suno'
SUNO_MCP_USER_AGENT = 'beiming-music-gen/1.0'

AIGC_ACESTEP = {
    'contains': True,
    'kinds': ['music'],
    'tools': ['ACE-Step-1.5'],
    'note': '配乐由 ACE-Step 1.5 Cover 模式依据程序化导引轨生成',
}

AIGC_SUNO = {
    'contains': True,
    'kinds': ['music'],
    'tools': ['Suno'],
    'note': '配乐由 Suno Cover 模式依据程序化导引轨生成',
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
    out_plan = {
        'dur': dur,
        'fps': fps,
        'key': key,
        'scale': scale,
        'bpm': bpm,
        'sections': sections,
    }
    if ev_times:
        out_plan['events'] = ev_times
    if mcfg.get('style'):
        out_plan['style'] = str(mcfg['style'])
    return out_plan


def build_guide_score(
    spec_or_sections,
    *,
    dur: float = None,
    fps: int = 24,
    key: str = 'D',
    scale: str = 'major',
    bpm: float = 96.0,
    style: str = None,
    prompt: str = '',
    world: str = None,
    events: list = None,
    midi_out: str = None,
    pad_tail_s: float = 0.0,
    sr: int = 48000,
    seed: int = 42,
) -> tuple[np.ndarray, dict]:
    """基于通用算法作曲引擎（engine.audio.composer）合成 100% 标准音高立体声情绪导引乐谱（及可选标准 MIDI）。"""
    sr_out = int(sr)
    if sr_out < 8000:
        raise CliError('usage.bad-value', f'采样率 sr 过低：{sr_out}')
    if style is not None and str(style).strip() and str(style).strip() not in COMP.COMPOSER_STYLES:
        raise CliError(
            'usage.bad-value',
            f'不认识的作曲风格 {style!r}',
            hint=f'可选：{" / ".join(COMP.COMPOSER_STYLES)}',
        )

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

    eff_style = (
        str(style).strip()
        if (style and str(style).strip())
        else (plan.get('style') if plan.get('style') in COMP.COMPOSER_STYLES else None)
    )
    score = COMP.compose_film_score(
        plan,
        dur=eff_dur,
        fps=eff_fps,
        key=eff_key,
        scale=eff_scale,
        bpm=eff_bpm,
        style=eff_style,
        prompt=prompt or str(plan.get('prompt') or ''),
        world=world or plan.get('world'),
        events=events if events is not None else plan.get('events'),
        seed=int(seed),
    )

    guide_st = COMP.render_score_wav(
        score,
        sr=sr_out,
        pad_tail_s=max(0.0, float(pad_tail_s)),
        peak_dbfs=-3.0,
        seed=int(seed),
    )

    midi_path_out = None
    if midi_out:
        midi_path_out = COMP.export_midi(score, str(midi_out))

    n_film = max(2, int(round(eff_dur * sr_out)))
    sec_metrics = []
    for sec in score['sections']:
        a = max(0, min(n_film, int(round(sec['t0'] * sr_out))))
        b = max(a + 1, min(n_film, int(round(sec['t1'] * sr_out))))
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
        'pad_tail_s': round(max(0.0, float(pad_tail_s)), 4),
        'fps': eff_fps,
        'sr': sr_out,
        'samples': len(guide_st),
        'key': eff_key,
        'scale': eff_scale,
        'bpm': eff_bpm,
        'style': score['style'],
        'seed': int(seed),
        'peak_dbfs': round(final_peak_db, 2),
        'lufs': round(float(lufs_val), 2) if math.isfinite(lufs_val) else None,
        'motif': {
            'archetype': score['motif']['archetype'],
            'degrees': list(score['motif']['degrees']),
            'intervals': list(score['motif']['intervals']),
        },
        'voice_leading': score['voice_leading'],
        'sections': sec_metrics,
    }
    if midi_path_out:
        meta['midi_path'] = rel(midi_path_out)
    return guide_st, meta


def _onset_flux_envelope(st: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """提取双频带（低频节拍底盘 + 中高频起音瞬态）半波整流能量斜率包络，用于 Cover 与导引轨拍点互相关对齐。"""
    mono = np.mean(np.asarray(st, dtype=np.float64), axis=1) if st.ndim == 2 else np.asarray(st, dtype=np.float64)
    if len(mono) < hop * 4:
        return np.zeros(1, dtype=np.float64)
    lo = sosfilt(butter(2, [55.0, min(750.0, 0.40 * sr)], 'band', fs=float(sr), output='sos'), mono)
    hi = sosfilt(butter(2, [750.0, min(8500.0, 0.44 * sr)], 'band', fs=float(sr), output='sos'), mono)

    win = 2 * hop
    m = max(1, (len(mono) - win) // hop + 1)
    cs_lo = np.concatenate([[0.0], np.cumsum(lo * lo)])
    cs_hi = np.concatenate([[0.0], np.cumsum(hi * hi)])
    idx = np.arange(m) * hop
    e_lo = np.log1p(30.0 * np.maximum(0.0, cs_lo[idx + win] - cs_lo[idx]) / float(win))
    e_hi = np.log1p(45.0 * np.maximum(0.0, cs_hi[idx + win] - cs_hi[idx]) / float(win))
    flux = 0.45 * np.maximum(0.0, np.diff(e_lo, prepend=e_lo[0])) + 0.55 * np.maximum(0.0, np.diff(e_hi, prepend=e_hi[0]))
    if len(flux) >= 3:
        flux = np.convolve(flux, np.array([0.25, 0.50, 0.25], dtype=np.float64), mode='same')
    return flux


def _phase_vocoder_pitch_locked_stereo(st: np.ndarray, stretch_ratio: float, sr: int) -> np.ndarray:
    """Laroche-Dolson 立体声身份锁相（Identity Phase-Locked）STFT 相位声码器 + 新生瞬态相位重置。

    硬保证：
      · 严格在频域按合成步长重排时间轴，绝不调用任何非保调时域重采样（基频偏移 0.00 cents！）；
      · 局部谱峰邻域整体共享同一复数旋转因子，左右声道同步旋转以 100% 保持立体声声像相位差与电平比；
      · 仅对通量突增的新生瞬态频点重置相位凝聚度，持续乐音基频连续锁相零跳变。
    """
    x = np.asarray(st, dtype=np.float64)
    n_in = len(x)
    if n_in <= 4 or abs(float(stretch_ratio) - 1.0) < 1e-6:
        return x.copy()

    n_out = max(2, int(round(n_in * float(stretch_ratio))))
    n_fft = 4096 if sr >= 32000 else 2048
    if n_in < n_fft:
        n_fft = max(256, 1 << int(math.floor(math.log2(max(256, n_in)))))
    hop_s = n_fft // 8
    hop_a = hop_s / float(stretch_ratio)
    win = np.hanning(n_fft + 1)[:-1]

    pad = n_fft
    x_pad = np.zeros((n_in + 2 * pad, 2), dtype=np.float64)
    x_pad[pad:pad + n_in] = x

    y_len = n_out + 2 * pad + n_fft
    y_pad = np.zeros((y_len, 2), dtype=np.float64)
    w_sum = np.zeros(y_len, dtype=np.float64)

    n_bins = n_fft // 2 + 1
    omega_bin = (2.0 * math.pi * np.arange(n_bins, dtype=np.float64)) / float(n_fft)
    bin_idx = np.arange(n_bins, dtype=np.int32)

    n_frames = int(math.ceil((n_out + pad) / float(hop_s))) + 1
    max_pos_a = len(x_pad) - n_fft

    prev_phi_l = np.zeros(n_bins, dtype=np.float64)
    psi_l = np.zeros(n_bins, dtype=np.float64)
    prev_mag = np.zeros(n_bins, dtype=np.float64)
    prev_pos_a = 0

    for m in range(n_frames):
        pos_s = m * hop_s
        if pos_s + n_fft > y_len:
            break
        pos_a = min(max_pos_a, max(0, int(round(m * hop_a))))
        seg_l = x_pad[pos_a:pos_a + n_fft, 0] * win
        seg_r = x_pad[pos_a:pos_a + n_fft, 1] * win
        X_l = np.fft.rfft(seg_l)
        X_r = np.fft.rfft(seg_r)
        phi_l = np.angle(X_l)
        mag = np.hypot(np.abs(X_l), np.abs(X_r))

        if m == 0:
            Y_l, Y_r = X_l, X_r
            psi_l = phi_l.copy()
        else:
            d_a = pos_a - prev_pos_a
            if d_a > 0:
                dp = (phi_l - prev_phi_l) - omega_bin * d_a
                dp = (dp + math.pi) % (2.0 * math.pi) - math.pi
                omega_inst = omega_bin + dp / float(d_a)
            else:
                omega_inst = omega_bin

            is_pk = np.zeros(n_bins, dtype=bool)
            is_pk[1:-1] = (mag[1:-1] >= mag[:-2]) & (mag[1:-1] >= mag[2:])
            is_pk[0] = mag[0] >= mag[1]
            is_pk[-1] = mag[-1] >= mag[-2]
            pk_indices = np.flatnonzero(is_pk)
            if len(pk_indices) == 0:
                pk_indices = np.array([0], dtype=np.int32)

            if len(pk_indices) == 1:
                nearest_pk = np.full(n_bins, pk_indices[0], dtype=np.int32)
            else:
                mids = (pk_indices[:-1] + pk_indices[1:]) // 2
                region = np.searchsorted(mids, bin_idx, side='right')
                nearest_pk = pk_indices[region]

            psi_pk = psi_l[pk_indices] + omega_inst[pk_indices] * hop_s

            # 仅对通量显著突增的新生打击瞬态频点做局部相位对齐，持续谐波峰 100% 连续锁相
            flux_ratio = float(np.sum(np.maximum(0.0, mag - prev_mag))) / (float(np.sum(prev_mag)) + 1e-9)
            if flux_ratio > 0.58:
                transient_pks = mag[pk_indices] > 2.35 * (prev_mag[pk_indices] + 1e-6)
                if np.any(transient_pks):
                    psi_pk = np.where(transient_pks, phi_l[pk_indices], psi_pk)

            rot_pk = psi_pk - phi_l[pk_indices]
            rot_all = np.zeros(n_bins, dtype=np.float64)
            rot_all[pk_indices] = rot_pk
            rot = rot_all[nearest_pk]
            psi_l = ((phi_l + rot + math.pi) % (2.0 * math.pi)) - math.pi

            phasor = np.exp(1j * rot)
            Y_l = X_l * phasor
            Y_r = X_r * phasor

        y_pad[pos_s:pos_s + n_fft, 0] += np.fft.irfft(Y_l, n=n_fft) * win
        y_pad[pos_s:pos_s + n_fft, 1] += np.fft.irfft(Y_r, n=n_fft) * win
        w_sum[pos_s:pos_s + n_fft] += win * win

        prev_phi_l = phi_l
        prev_mag = mag
        prev_pos_a = pos_a

    norm_w = np.maximum(w_sum, 1e-8)[:, None]
    y_rec = y_pad / norm_w
    return y_rec[pad:pad + n_out].copy()


def _shift_stereo_constant_offset(st: np.ndarray, shift_samples: int, sr: int) -> np.ndarray:
    """样本级恒定时间平移（shift_samples > 0 表示将迟到的 Cover 向前拉齐；< 0 表示向后推迟并平滑前导）。"""
    x = np.asarray(st, dtype=np.float64)
    n = len(x)
    if shift_samples == 0 or n == 0:
        return x.copy()
    if shift_samples > 0:
        if shift_samples >= n:
            return np.zeros_like(x)
        out = np.zeros_like(x)
        rem = n - shift_samples
        out[:rem] = x[shift_samples:]
        return _fit_stereo_duration(out[:rem], n, sr)
    delay = -shift_samples
    if delay >= n:
        return np.zeros_like(x)
    out = np.zeros((n + delay, 2), dtype=np.float64)
    out[delay:] = x
    fin_n = min(int(round(0.012 * sr)), len(x) // 4)
    if fin_n > 2:
        ramp = (np.sin(np.linspace(0.0, 0.5 * math.pi, fin_n, dtype=np.float64)) ** 2)[:, None]
        out[delay:delay + fin_n] *= ramp
    return out[:n]


def align_cover_pitch_locked(
    cover_st: np.ndarray,
    guide_st: np.ndarray,
    *,
    sr: int = 48000,
    max_shift_ms: float = 140.0,
    allow_uniform_stretch: bool = True,
    max_stretch_pct: float = 2.5,
) -> tuple[np.ndarray, dict]:
    """零跑调（0.0 cents）Cover 音轨与导引乐谱拍点对齐。

    硬护栏：
      · 严禁调用任何时域变速重采样（如 PCHIP / 线性插值重采样）扭曲乐团音高！
      · 第一步：估计 ±max_shift_ms 内的恒定起音包络滞后；
      · 第二步：若 allow_uniform_stretch=True 且 ±max_stretch_pct% 内的微小全局均匀伸缩能显著提升全片节拍锁定度，
        仅通过立体声身份锁相 STFT 相位声码器（0.0 cents 音高漂移）执行均匀时间伸缩，否则仅执行样本级恒定平移（0% 伸缩）。
    """
    sr_i = int(sr)
    cov = np.asarray(cover_st, dtype=np.float64)
    gui = np.asarray(guide_st, dtype=np.float64)
    if cov.ndim == 1:
        cov = np.stack([cov, cov], axis=1)
    elif cov.shape[1] == 1:
        cov = np.concatenate([cov, cov], axis=1)
    else:
        cov = cov[:, :2].copy()

    if gui.ndim == 1:
        gui = np.stack([gui, gui], axis=1)
    elif gui.shape[1] == 1:
        gui = np.concatenate([gui, gui], axis=1)
    else:
        gui = gui[:, :2]

    hop = max(16, int(round(0.004 * sr_i)))  # 4 ms 包络帧率
    env_g = _onset_flux_envelope(gui, sr_i, hop)
    env_c = _onset_flux_envelope(cov, sr_i, hop)

    n_common = min(len(env_g), len(env_c))
    if n_common < 24 or float(np.std(env_g[:n_common])) < 1e-5 or float(np.std(env_c[:n_common])) < 1e-5:
        return cov, {
            'method': 'identity',
            'shift_ms': 0.0,
            'stretch_ratio': 1.0,
            'pitch_drift_cents': 0.0,
            'corr_before': 0.0,
            'corr_after': 0.0,
        }

    def _norm_vec(v: np.ndarray) -> np.ndarray:
        z = v - float(np.mean(v))
        nrm = float(np.linalg.norm(z))
        return z / nrm if nrm > 1e-12 else np.zeros_like(z)

    max_lag = max(1, int(round((max(0.0, float(max_shift_ms)) * 1e-3 * sr_i) / float(hop))))

    def _best_lag_corr(eg: np.ndarray, ec: np.ndarray) -> tuple[float, float, float]:
        m_len = min(len(eg), len(ec))
        if m_len < 16:
            return 0.0, 0.0, 0.0
        g0 = _norm_vec(eg[:m_len])
        c0 = _norm_vec(ec[:m_len])
        zero_c = float(np.dot(g0, c0))
        lags = range(-min(max_lag, m_len // 4), min(max_lag, m_len // 4) + 1)
        scores = []
        lag_list = list(lags)
        for lg in lag_list:
            if lg >= 0:
                a_g = eg[:m_len - lg]
                a_c = ec[lg:lg + len(a_g)]
            else:
                d = -lg
                a_g = eg[d:m_len]
                a_c = ec[:len(a_g)]
            if len(a_g) < 12:
                scores.append(-1.0)
                continue
            scores.append(float(np.dot(_norm_vec(a_g), _norm_vec(a_c))))
        sc_arr = np.asarray(scores, dtype=np.float64)
        best_i = int(np.argmax(sc_arr))
        best_sc = float(sc_arr[best_i])
        frac = 0.0
        if 0 < best_i < len(sc_arr) - 1:
            y0, y1, y2 = sc_arr[best_i - 1], sc_arr[best_i], sc_arr[best_i + 1]
            denom = y0 - 2.0 * y1 + y2
            if abs(denom) > 1e-12:
                frac = float(np.clip(0.5 * (y0 - y2) / denom, -0.5, 0.5))
        return float(lag_list[best_i]) + frac, best_sc, zero_c

    best_lag_f, corr_shift, corr_zero = _best_lag_corr(env_g, env_c)
    chosen_ratio = 1.0
    chosen_lag_f = best_lag_f if (corr_shift > corr_zero + 0.012) else 0.0
    chosen_corr = corr_shift if (corr_shift > corr_zero + 0.012) else corr_zero
    method = 'offset_shift' if abs(chosen_lag_f) > 0.12 else 'identity'

    max_pct = float(np.clip(max_stretch_pct, 0.0, 5.0))
    if allow_uniform_stretch and max_pct > 0.05 and (n_common * hop / float(sr_i)) >= 1.8:
        ratios = np.linspace(1.0 - max_pct / 100.0, 1.0 + max_pct / 100.0, 33)
        best_r = 1.0
        best_r_lag = chosen_lag_f
        best_r_sc = chosen_corr
        src_x = np.arange(len(env_c), dtype=np.float64)
        for r_cand in ratios:
            if abs(r_cand - 1.0) <= 0.002:
                continue
            out_m = max(16, int(round(len(env_c) * r_cand)))
            q_x = np.arange(out_m, dtype=np.float64) / float(r_cand)
            ec_stretched = np.interp(q_x, src_x, env_c, left=0.0, right=0.0)
            lg_r, sc_r, _ = _best_lag_corr(env_g, ec_stretched)
            if sc_r > best_r_sc:
                best_r_sc = sc_r
                best_r = float(r_cand)
                best_r_lag = lg_r

        # 仅当均匀微伸缩明显优于纯常量偏移时才启用锁相声码器
        if abs(best_r - 1.0) > 0.002 and best_r_sc > max(corr_zero, corr_shift) + 0.045 and best_r_sc >= 0.20:
            chosen_ratio = best_r
            chosen_lag_f = best_r_lag
            chosen_corr = best_r_sc
            method = 'phase_vocoder_locked'

    out_st = cov
    if method == 'phase_vocoder_locked':
        out_st = _phase_vocoder_pitch_locked_stereo(out_st, chosen_ratio, sr_i)

    shift_samples = int(round(chosen_lag_f * hop))
    if shift_samples != 0:
        out_st = _shift_stereo_constant_offset(out_st, shift_samples, sr_i)

    shift_ms_val = round((shift_samples / float(sr_i)) * 1000.0, 3)
    return out_st, {
        'method': method,
        'shift_ms': shift_ms_val,
        'shift_samples': int(shift_samples),
        'stretch_ratio': round(float(chosen_ratio), 6),
        'pitch_drift_cents': 0.0,
        'corr_before': round(float(corr_zero), 4),
        'corr_after': round(float(chosen_corr), 4),
    }


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
    merged_hdrs = dict(headers or {})
    if not any(k.lower() == 'user-agent' for k in merged_hdrs):
        merged_hdrs['User-Agent'] = SUNO_MCP_USER_AGENT
    req = urllib.request.Request(url, data=body, headers=merged_hdrs, method=method)
    opener = _build_http_opener(url)
    with opener.open(req, timeout=max(0.5, float(timeout_s))) as resp:
        status = int(getattr(resp, 'status', 200))
        raw = resp.read()
        hdrs = dict(resp.headers.items())
        return status, raw, hdrs


def _decode_audio_bytes(raw_bytes: bytes) -> tuple[np.ndarray, int]:
    """解码音频字节流（WAV / FLAC / OGG / MP3），soundfile 失败时可选经 ffmpeg 回退解码。"""
    try:
        arr, sr_in = sf.read(io.BytesIO(raw_bytes), always_2d=True, dtype='float64')
        return arr, int(sr_in)
    except Exception as sf_exc:
        ffmpeg_bin = _env.find_ffmpeg() if hasattr(_env, 'find_ffmpeg') else shutil.which('ffmpeg')
        if isinstance(ffmpeg_bin, dict):
            ffmpeg_bin = ffmpeg_bin.get('path')
        if ffmpeg_bin:
            proc = subprocess.run(
                [str(ffmpeg_bin), '-v', 'error', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_f32le', 'pipe:1'],
                input=raw_bytes,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                arr, sr_in = sf.read(io.BytesIO(proc.stdout), always_2d=True, dtype='float64')
                return arr, int(sr_in)
        raise sf_exc


def _resolve_suno_mcp_url(endpoint: str | None) -> str:
    """按优先级解析 Suno MCP 服务地址：--endpoint → BEIMING_SUNO_MCP_URL → DEFAULT_SUNO_MCP_URL。"""
    env_url = (os.environ.get('BEIMING_SUNO_MCP_URL') or '').strip()
    chosen = (endpoint or '').strip() or env_url or DEFAULT_SUNO_MCP_URL
    parsed = urllib.parse.urlparse(chosen)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise CliError(
            'usage.bad-value',
            f'Suno MCP 服务地址格式不合法：{chosen!r}',
            hint=f'应以 http:// 或 https:// 开头，默认 {DEFAULT_SUNO_MCP_URL}',
        )
    return chosen


def _parse_mcp_rpc_response(raw: bytes, headers: dict, req_id: int) -> dict:
    """解析 MCP HTTP JSON-RPC 响应，同时兼容 application/json 与 text/event-stream（SSE data: {...}）。"""
    text = raw.decode('utf-8', errors='replace').strip()
    if not text:
        return {}
    ctype = ''
    for k, v in (headers or {}).items():
        if k.lower() == 'content-type':
            ctype = str(v).lower()
            break

    is_sse = ('text/event-stream' in ctype) or text.startswith(('event:', 'data:'))
    if not is_sse:
        try:
            doc = json.loads(text)
            if isinstance(doc, dict):
                return doc
        except ValueError as exc:
            raise CliError('failure.suno-mcp', f'Suno MCP 返回非合法 JSON 响应：{exc}') from None
        raise CliError('failure.suno-mcp', f'Suno MCP 顶层 JSON 不是对象：{type(doc).__name__}')

    # 解析 SSE 事件块（兼容单行与多行 data: 帧）
    events: list[dict] = []
    cur_data: list[str] = []
    for line in text.splitlines() + ['']:
        if not line.strip():
            if cur_data:
                joined = '\n'.join(cur_data).strip()
                cur_data = []
                if joined:
                    try:
                        obj = json.loads(joined)
                        if isinstance(obj, dict):
                            events.append(obj)
                    except ValueError:
                        pass
            continue
        if line.startswith('data:'):
            cur_data.append(line[5:].lstrip())

    for ev in events:
        if ev.get('id') == req_id and ('result' in ev or 'error' in ev):
            return ev
    for ev in reversed(events):
        if 'result' in ev or 'error' in ev:
            return ev
    if events:
        return events[-1]
    raise CliError('failure.suno-mcp', f'Suno MCP SSE 响应中未找到有效 JSON-RPC data 帧：{text[:200]!r}')


def _parse_mcp_text_blocks(texts: list[str]):
    """从 MCP content[].text 文本块列表中提取 JSON 载荷（兼容 [json_str, hint_text] 多段返回与 JSON 后缀提示语）。"""
    joined = '\n'.join(texts).strip()
    if not joined:
        return ''
    try:
        return json.loads(joined)
    except ValueError:
        pass

    decoder = json.JSONDecoder()
    for blk in texts:
        s = blk.strip()
        if not s:
            continue
        try:
            parsed = json.loads(s)
            if isinstance(parsed, (dict, list)):
                return parsed
        except ValueError:
            pass
        if s.startswith(('{', '[')):
            try:
                parsed, _ = decoder.raw_decode(s)
                if isinstance(parsed, (dict, list)):
                    return parsed
            except ValueError:
                pass

    stripped = joined.lstrip()
    if stripped.startswith(('{', '[')):
        try:
            parsed, _ = decoder.raw_decode(stripped)
            if isinstance(parsed, (dict, list)):
                return parsed
        except ValueError:
            pass
    return joined


def _unwrap_mcp_tool_result(rpc_doc: dict, tool_name: str):
    """解包 MCP tools/call 返回结构（兼容 structuredContent、单块与多块 [json_str, hint_text] content[].text）。"""
    if not isinstance(rpc_doc, dict):
        raise CliError('failure.suno-mcp', f'Suno MCP {tool_name} 响应格式异常')
    if rpc_doc.get('error'):
        err = rpc_doc['error']
        msg = err.get('message') if isinstance(err, dict) else str(err)
        raise CliError('failure.suno-mcp', f'Suno MCP {tool_name} 调用报错：{msg}')

    res = rpc_doc.get('result')
    if not isinstance(res, dict):
        return res

    is_err = bool(res.get('isError'))
    payload = None
    if isinstance(res.get('structuredContent'), dict):
        payload = res['structuredContent']
    elif isinstance(res.get('content'), list):
        texts = [
            str(item.get('text'))
            for item in res['content']
            if isinstance(item, dict) and item.get('type') == 'text' and item.get('text') is not None
        ]
        if texts:
            payload = _parse_mcp_text_blocks(texts)
    if payload is None:
        payload = res

    if is_err:
        detail = payload.get('error') or payload.get('message') if isinstance(payload, dict) else payload
        raise CliError('failure.suno-mcp', f'Suno MCP 工具 {tool_name} 返回错误：{detail}')
    if isinstance(payload, dict) and payload.get('error') and not any(
        k in payload for k in ('id', 'clips', 'clip_ids', 'items', 'allowed_models', 'suno_account', 'url', 'upload_url')
    ):
        reason = payload.get('reason') or payload.get('code') or ''
        suffix = f'（{reason}）' if reason else ''
        raise CliError('failure.suno-mcp', f'Suno MCP {tool_name} 被拒绝{suffix}：{payload.get("error")}')
    return payload


class _SunoMcpSession:
    """轻量级本地 Magpie Suno MCP JSON-RPC 会话客户端（强制显式 User-Agent，兼容 JSON / SSE 与 Mcp-Session-Id）。"""

    def __init__(self, mcp_url: str, *, timeout_s: float = 30.0):
        self.mcp_url = mcp_url
        self.timeout_s = max(1.0, float(timeout_s))
        self.session_id: str | None = None
        self.server_info: dict | None = None
        self._next_id = 1

    def _rpc(self, method: str, params: dict, *, timeout_s: float | None = None, unreachable_exit3: bool = False) -> dict:
        req_id = self._next_id
        self._next_id += 1
        body = json.dumps({
            'jsonrpc': '2.0',
            'id': req_id,
            'method': method,
            'params': params,
        }, ensure_ascii=False).encode('utf-8')
        hdrs = {
            'User-Agent': SUNO_MCP_USER_AGENT,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        }
        if self.session_id:
            hdrs['Mcp-Session-Id'] = self.session_id

        eff_timeout = max(0.5, float(timeout_s if timeout_s is not None else self.timeout_s))
        try:
            _, raw, resp_hdrs = _http_request(
                self.mcp_url,
                method='POST',
                body=body,
                headers=hdrs,
                timeout_s=eff_timeout,
            )
        except urllib.error.HTTPError as exc:
            err_body = ''
            try:
                err_body = exc.read().decode('utf-8', errors='replace').strip()[:240]
            except OSError:
                pass
            detail = f'HTTP {exc.code}' + (f' ({err_body})' if err_body else '')
            if unreachable_exit3:
                raise CliError(
                    'env.music-unreachable',
                    f'Suno MCP 服务返回错误（{self.mcp_url}）：{detail}',
                    hint='确认本地 Magpie Suno MCP（http://127.0.0.1:3425/mcp/suno）在线且已登录，或改用 --provider guide',
                    exit_code=3,
                ) from None
            raise CliError('failure.suno-mcp', f'Suno MCP {method} 请求失败：{detail}') from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if unreachable_exit3:
                raise CliError(
                    'env.music-unreachable',
                    f'连接 Suno MCP 服务失败（{self.mcp_url}）：{exc}',
                    hint='确认本地 Magpie Suno MCP 已启动，或改用 --provider guide 走离线导引轨模式',
                    exit_code=3,
                ) from None
            raise CliError('failure.suno-mcp', f'Suno MCP {method} 网络异常：{exc}') from None

        for hk, hv in resp_hdrs.items():
            if hk.lower() == 'mcp-session-id' and str(hv).strip():
                self.session_id = str(hv).strip()
                break

        return _parse_mcp_rpc_response(raw, resp_hdrs, req_id)

    def initialize(self, *, timeout_s: float | None = None) -> dict:
        doc = self._rpc(
            'initialize',
            {
                'protocolVersion': '2025-03-26',
                'capabilities': {},
                'clientInfo': {'name': 'beiming-music-gen', 'version': '1.0'},
            },
            timeout_s=timeout_s,
            unreachable_exit3=True,
        )
        if doc.get('error'):
            err = doc['error']
            msg = err.get('message') if isinstance(err, dict) else str(err)
            raise CliError('env.music-unreachable', f'Suno MCP initialize 失败：{msg}', exit_code=3)
        res = doc.get('result') if isinstance(doc.get('result'), dict) else {}
        if isinstance(res.get('serverInfo'), dict):
            self.server_info = dict(res['serverInfo'])
        return res

    def call_tool(self, name: str, arguments: dict | None = None, *, timeout_s: float | None = None,
                  unreachable_exit3: bool = False):
        doc = self._rpc(
            'tools/call',
            {'name': name, 'arguments': dict(arguments or {})},
            timeout_s=timeout_s,
            unreachable_exit3=unreachable_exit3,
        )
        return _unwrap_mcp_tool_result(doc, name)


def _pad_guide_for_suno(guide_st: np.ndarray, sr: int, min_dur_s: float = 16.0) -> np.ndarray:
    """Suno 要求导引上传与生成时长 >= 15s；当导引轨短于 15.5s 时在尾部平滑交叉淡化延展温暖余韵至 min_dur_s。"""
    x = np.asarray(guide_st, dtype=np.float64)
    min_check = int(round(15.5 * sr))
    if len(x) >= min_check:
        return x

    n_pad = max(int(round(float(min_dur_s) * sr)), min_check + int(round(0.5 * sr)))
    out = np.zeros((n_pad, 2), dtype=np.float64)
    if len(x) == 0:
        return out

    n_orig = len(x)
    out[:n_orig] = x

    # 取导引轨末尾温暖和弦余韵窗口做镜像交替交叉淡化慢衰减，杜绝硬截断台阶与全零静音被服务端截短
    win_len = min(n_orig, max(64, int(round(1.8 * sr))))
    tail_win = x[n_orig - win_len:].copy()
    tail_rev = tail_win[::-1].copy()
    xf = min(max(8, int(round(0.035 * sr))), win_len // 3)
    step = max(16, win_len - xf)

    pos = n_orig - xf if n_orig > xf else n_orig
    seg_idx = 0
    while pos < n_pad:
        chunk = tail_rev if (seg_idx % 2 == 0) else tail_win
        avail = min(len(chunk), n_pad - pos)
        if avail <= 0:
            break
        prog0 = max(0.0, (pos - n_orig) / float(max(1, n_pad - n_orig)))
        prog1 = max(0.0, (pos + avail - n_orig) / float(max(1, n_pad - n_orig)))
        env = np.linspace(
            0.42 * math.exp(-2.1 * prog0),
            0.42 * math.exp(-2.1 * prog1),
            avail,
            dtype=np.float64,
        )[:, None]
        seg = chunk[:avail] * env
        ov = min(xf, avail) if pos >= max(0, n_orig - xf) else 0
        if ov > 2 and pos + ov <= n_pad:
            u = np.linspace(0.0, 1.0, ov, dtype=np.float64)[:, None]
            out[pos:pos + ov] = out[pos:pos + ov] * (1.0 - u) + seg[:ov] * u
            if avail > ov:
                out[pos + ov:pos + avail] = seg[ov:avail]
        else:
            out[pos:pos + avail] = seg
        pos += step
        seg_idx += 1

    fout_n = min(int(round(0.25 * sr)), n_pad - n_orig)
    if fout_n > 2:
        fade_curve = 0.5 * (1.0 + np.cos(math.pi * np.linspace(0.0, 1.0, fout_n, dtype=np.float64)))[:, None]
        out[n_pad - fout_n:] *= fade_curve
    out[0] = 0.0
    out[-1] = 0.0
    return out


def _extract_suno_clips(doc) -> list[dict]:
    if isinstance(doc, list):
        return [c for c in doc if isinstance(c, dict)]
    if not isinstance(doc, dict):
        return []
    if isinstance(doc.get('clips'), list) and doc['clips']:
        return [c for c in doc['clips'] if isinstance(c, dict)]
    if isinstance(doc.get('items'), list) and doc['items']:
        return [c for c in doc['items'] if isinstance(c, dict)]
    if doc.get('id'):
        return [doc]
    return []


def _extract_suno_clip_ids(doc) -> list[str]:
    ids: list[str] = []
    if isinstance(doc, dict) and isinstance(doc.get('clip_ids'), list):
        ids.extend(str(x).strip() for x in doc['clip_ids'] if str(x).strip())
    for c in _extract_suno_clips(doc):
        cid = str(c.get('id') or '').strip()
        if cid and cid not in ids:
            ids.append(cid)
    return ids


def _extract_suno_download_url(dl_doc) -> str | None:
    if not isinstance(dl_doc, dict):
        return None
    for key in ('download_url', 'url', 'audio_url', 'file_url'):
        val = dl_doc.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _request_suno_audio_download(
    sess: _SunoMcpSession,
    clip_id: str,
    *,
    fmt: str = 'wav',
    confirm: bool = True,
    rem_fn,
) -> str | None:
    """调用 Suno MCP audio-download 获取下载链接；遇到 processing 时严格遵守 >=1 req/s 限速轮询。"""
    while True:
        dl_doc = sess.call_tool(
            'audio-download',
            {'id': clip_id, 'format': fmt, 'confirm': bool(confirm)},
            timeout_s=rem_fn(60.0),
        )
        dl_url = _extract_suno_download_url(dl_doc)
        if dl_url:
            return dl_url
        if isinstance(dl_doc, dict) and str(dl_doc.get('status') or '').lower() == 'processing':
            rem_fn(5.0)
            time.sleep(1.05)
            continue
        return None


def _extract_suno_audio_url(clip: dict) -> str | None:
    if not isinstance(clip, dict):
        return None
    for key in ('audio_url', 'stream_url', 'file_url', 'url'):
        val = clip.get(key)
        if not isinstance(val, str) or not val.strip():
            continue
        u = val.strip()
        lower_u = u.lower().split('?', 1)[0]
        if lower_u.endswith(('.jpg', '.jpeg', '.png', '.webp', '.gif')):
            continue
        if 'suno.com/song/' in lower_u:
            continue
        return u
    return None


def _call_suno_cover_mcp(
    mcp_url: str,
    *,
    guide_fitted: np.ndarray,
    guide_digest: str,
    prompt: str,
    lyrics: str,
    negative_style: str | None,
    model: str,
    dur: float,
    cover_strength: float,
    idempotency_key: str,
    prefer_wav_download: bool,
    sr_out: int,
    timeout_s: float,
) -> bytes:
    deadline = time.monotonic() + max(5.0, float(timeout_s))

    def _rem(cap: float = 65.0) -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise CliError(
                'timeout.suno',
                f'等待 Suno Cover 生成超时（>{timeout_s:.1f}s）',
                hint='调大 --timeout 后重试（相同输入会自动携带相同 idempotency_key 防重复扣费）',
            )
        return min(cap, max(1.0, left))

    suno_duration = min(360, max(15, int(math.ceil(float(dur)))))
    upload_st = _pad_guide_for_suno(guide_fitted, sr_out, min_dur_s=16.0)
    upload_wav_bytes = _encode_wav_pcm16_bytes(upload_st, sr_out)

    sess = _SunoMcpSession(mcp_url, timeout_s=min(30.0, max(5.0, float(timeout_s))))
    sess.initialize(timeout_s=_rem(20.0))

    # 1) 创建上传会话 -> HTTP PUT 原始音频字节 -> complete -> 等待上传音频状态 complete
    up_title = f'beiming-guide-{guide_digest[:12]}.wav'
    up_init = sess.call_tool('audio-upload-create', {'title': up_title}, timeout_s=_rem(30.0))
    if not isinstance(up_init, dict):
        raise CliError('failure.suno-upload', f'audio-upload-create 返回异常：{up_init!r}')
    upload_id = str(up_init.get('id') or up_init.get('upload_id') or up_init.get('clip_id') or '').strip()
    upload_url = str(up_init.get('upload_url') or '').strip()
    if not upload_id or not upload_url:
        raise CliError('failure.suno-upload', f'audio-upload-create 缺少 id 或 upload_url：{up_init!r}')

    put_qs = urllib.parse.parse_qs(urllib.parse.urlparse(upload_url).query)
    signed_ctype = (put_qs.get('Content-Type') or put_qs.get('content-type') or [None])[0]
    put_headers = {
        'User-Agent': SUNO_MCP_USER_AGENT,
        'Content-Type': signed_ctype or 'audio/wav',
    }
    try:
        put_status, _, _ = _http_request(
            upload_url,
            method='PUT',
            body=upload_wav_bytes,
            headers=put_headers,
            timeout_s=_rem(60.0),
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CliError('failure.suno-upload', f'PUT 导引音轨至 upload_url 失败：{exc}') from None
    if not (200 <= put_status < 300):
        raise CliError('failure.suno-upload', f'PUT 导引音轨返回非 2xx 状态码：HTTP {put_status}')

    sess.call_tool('audio-upload-complete', {'id': upload_id}, timeout_s=_rem(30.0))

    up_wait = sess.call_tool('audio-wait', {'ids': [upload_id], 'until': 'complete'}, timeout_s=_rem(65.0))
    up_clips = _extract_suno_clips(up_wait)
    up_status = str((up_clips[0].get('status') if up_clips else (up_wait.get('status') if isinstance(up_wait, dict) else '')) or '').lower()
    poll_idx = 0
    while up_status != 'complete':
        if up_status in ('error', 'failed', 'cancelled'):
            err_detail = up_clips[0].get('error') if up_clips else up_wait
            raise CliError('failure.suno-upload', f'Suno 导引音轨上传处理失败（id={upload_id}）：{err_detail}')
        _rem(10.0)
        time.sleep(min(1.0, 0.05 * (1.4 ** min(poll_idx, 8))))
        poll_idx += 1
        up_ret = sess.call_tool('audio-retrieve', {'id': upload_id}, timeout_s=_rem(25.0))
        if isinstance(up_ret, dict):
            up_clips = [up_ret]
            up_status = str(up_ret.get('status') or '').lower()

    # 2) 调用 audio-covers-create（纯器乐时严格省略 lyrics，且绝不设置 max_mode=True！）
    audio_inf = round(float(np.clip(cover_strength, 0.0, 1.0)), 2)
    cover_args: dict = {
        'id': upload_id,
        'model': str(model or 'v6').strip() or 'v6',
        'style': str(prompt or '').strip()[:1000],
        'controls': {
            'audio_influence': audio_inf,
            'style_influence': 0.80,
        },
        'duration': int(suno_duration),
        'idempotency_key': str(idempotency_key).strip()[:255],
    }
    raw_lyr = str(lyrics or '').strip()
    if raw_lyr and raw_lyr.lower() not in ('[inst]', '[instrumental]', 'instrumental'):
        cover_args['lyrics'] = raw_lyr[:5000]
    norm_neg = str(negative_style or '').strip()
    if norm_neg:
        cover_args['negative_style'] = norm_neg[:1000]
    if 'max_mode' in cover_args:
        del cover_args['max_mode']

    cov_res = sess.call_tool('audio-covers-create', cover_args, timeout_s=_rem(45.0))
    clip_ids = _extract_suno_clip_ids(cov_res)
    if not clip_ids:
        raise CliError('failure.suno-submit', f'audio-covers-create 未返回 clip_ids：{cov_res!r}')

    # 3) audio-wait 等待生成完成 -> audio-retrieve 核验状态与音频链接 -> 下载解码
    wait_res = sess.call_tool('audio-wait', {'ids': clip_ids[:12], 'until': 'complete'}, timeout_s=_rem(65.0))
    wait_by_id = {str(c.get('id')): c for c in _extract_suno_clips(wait_res) if c.get('id')}

    chosen_clip: dict | None = None
    poll_cov = 0
    while chosen_clip is None:
        _rem(10.0)
        errors_seen: list[str] = []
        pending_ids: list[str] = []
        for cid in clip_ids:
            ret_doc = sess.call_tool('audio-retrieve', {'id': cid}, timeout_s=_rem(25.0))
            if not isinstance(ret_doc, dict):
                continue
            # 合并 audio-wait 已返回的附加字段（若 audio-retrieve 省略了部分链接）
            merged_clip = dict(wait_by_id.get(cid) or {})
            merged_clip.update(ret_doc)
            st_str = str(merged_clip.get('status') or '').lower()
            if st_str == 'complete':
                chosen_clip = merged_clip
                break
            if st_str in ('error', 'failed', 'cancelled'):
                errors_seen.append(f"{cid}:{merged_clip.get('error') or st_str}")
            else:
                pending_ids.append(cid)

        if chosen_clip is not None:
            break
        if not pending_ids and errors_seen:
            raise CliError('failure.suno-task', f'Suno Cover 生成失败：{"; ".join(errors_seen)}')

        time.sleep(min(1.2, 0.06 * (1.45 ** min(poll_cov, 8))))
        poll_cov += 1
        wait_res = sess.call_tool('audio-wait', {'ids': pending_ids[:12], 'until': 'complete'}, timeout_s=_rem(65.0))
        for c in _extract_suno_clips(wait_res):
            if c.get('id'):
                wait_by_id[str(c['id'])] = c

    chosen_id = str(chosen_clip['id'])
    download_url: str | None = None

    # 1) 前向兼容：若 clip 已直接附带免积分 audio_url 且未强制要求无损 WAV，优先直连拉取
    if not prefer_wav_download:
        download_url = _extract_suno_audio_url(chosen_clip)

    # 2) 真实 Magpie Suno MCP 路径（audio-retrieve/audio-wait 仅返 song_url 无 audio_url）或显式 prefer_wav_download：
    #    仅对首个 complete 曲目调用一次 audio-download(format='wav', confirm=True) 拉取无损 WAV（遵守 1 req/s 限流）
    if not download_url:
        download_url = _request_suno_audio_download(
            sess,
            chosen_id,
            fmt='wav',
            confirm=True,
            rem_fn=_rem,
        )

    if not download_url:
        download_url = _extract_suno_audio_url(chosen_clip)

    if not download_url:
        raise CliError(
            'failure.suno-download',
            f'Suno 曲目 {chosen_id} 已完成，但未能从 audio_url 或 audio-download 获取音频下载链接',
            hint='确认当前 Suno 账号具备 audio.download 权限且剩余下载配额充足',
        )

    try:
        dl_status, audio_bytes, _ = _http_request(
            download_url,
            method='GET',
            headers={'User-Agent': SUNO_MCP_USER_AGENT},
            timeout_s=_rem(60.0),
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise CliError('failure.suno-download', f'下载 Suno Cover 音频失败（{download_url!r}）：{exc}') from None
    if not (200 <= dl_status < 300) or not audio_bytes:
        raise CliError('failure.suno-download', f'下载 Suno Cover 音频返回异常（HTTP {dl_status}，字节数={len(audio_bytes)}）')
    return audio_bytes


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
    model: str = 'v6',
    negative_style: str = None,
    prefer_wav_download: bool = False,
    align_guide: bool = True,
    pad_tail_s: float = 0.0,
    cache_dir: str = None,
    out_wav: str = None,
    offline: bool = False,
    timeout_s: float = 300.0,
    sr: int = 48000,
) -> dict:
    """将导引音轨送入 ACE-Step 1.5 / Suno Cover 模式（或离线确定性 guide 模式），输出精确 N(dur) 立体声 PCM_24 配乐。"""
    prov = (provider or 'acestep').strip().lower()
    if prov not in ('acestep', 'suno', 'guide'):
        raise CliError(
            'usage.bad-value',
            f'不认识的配乐生成服务 {provider!r}',
            hint='可选：acestep（ACE-Step 1.5 Cover）、suno（本地 Magpie Suno MCP Cover）或 guide（离线确定性导引轨）',
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
    eff_pad_tail = max(0.0, float(pad_tail_s))
    n_upload = max(n_target, int(round((eff_dur + eff_pad_tail) * sr_out)))

    guide_fitted = _fit_stereo_duration(g_arr, n_target, sr_out)
    if eff_pad_tail > 0.0:
        if len(g_arr) >= n_upload:
            guide_upload = g_arr[:n_upload].copy()
        else:
            guide_upload = _pad_guide_for_suno(guide_fitted, sr_out, min_dur_s=eff_dur + eff_pad_tail)
    else:
        guide_upload = guide_fitted
    guide_digest = _pcm16_digest(guide_fitted)
    norm_prompt = str(prompt or '').strip()
    norm_lyrics = str(lyrics or '[inst]').strip() or '[inst]'
    suno_model = str(model or 'v6').strip() or 'v6'
    norm_neg = str(negative_style or '').strip()

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

    # provider in ('acestep', 'suno')：计算确定性缓存键
    if prov == 'suno':
        suno_lyr_key = '' if norm_lyrics.lower() in ('', '[inst]', '[instrumental]', 'instrumental') else norm_lyrics
        key_tuple = [
            guide_digest,
            norm_prompt,
            suno_lyr_key,
            norm_neg,
            round(float(cover_strength), 2),
            int(seed),
            round(eff_dur, 4),
            f'suno:{suno_model}',
        ]
        default_aigc = AIGC_SUNO
    else:
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
        default_aigc = AIGC_ACESTEP

    if sr_out != SR:
        key_tuple.append(sr_out)
    if eff_pad_tail > 0.0:
        key_tuple.append(f'pad:{round(eff_pad_tail, 2)}')
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
                    'aigc': dict(meta_doc.get('aigc') or default_aigc),
                }
        except Exception:
            # 缓存损坏时按未命中处理（离线模式报错，在线模式重算覆盖）
            pass

    if offline:
        prov_label = 'Suno MCP' if prov == 'suno' else 'ACE-Step 1.5'
        raise CliError(
            'env.music-offline',
            f'离线模式（--offline）下配乐缓存未命中：{cache_key[:12]}',
            hint=f'去掉 --offline 连接 {prov_label} 生成一次写入缓存，或临时改用 --provider guide 合成导引轨',
            exit_code=3,
        )

    if prov == 'suno':
        mcp_url = _resolve_suno_mcp_url(endpoint)
        gen_bytes = _call_suno_cover_mcp(
            mcp_url,
            guide_fitted=guide_upload,
            guide_digest=guide_digest,
            prompt=norm_prompt,
            lyrics=norm_lyrics,
            negative_style=norm_neg,
            model=suno_model,
            dur=eff_dur + eff_pad_tail,
            cover_strength=float(cover_strength),
            idempotency_key=f'beiming-suno-{cache_key[:40]}',
            prefer_wav_download=bool(prefer_wav_download),
            sr_out=sr_out,
            timeout_s=float(timeout_s),
        )
        try:
            raw_gen, gen_sr = _decode_audio_bytes(gen_bytes)
        except Exception as exc:
            raise CliError('failure.suno-decode', f'解码 Suno 返回音频失败：{exc}') from None
        cache_params = {
            'guide_pcm16_sha256': guide_digest,
            'prompt': norm_prompt,
            'lyrics': '' if norm_lyrics.lower() in ('', '[inst]', '[instrumental]', 'instrumental') else norm_lyrics,
            'negative_style': norm_neg,
            'cover_strength': round(float(cover_strength), 2),
            'seed': int(seed),
            'dur': round(eff_dur, 4),
            'suno_duration': min(360, max(15, int(math.ceil(eff_dur + eff_pad_tail)))),
            'model': suno_model,
            'provider': 'suno',
        }
    else:
        guide_wav_bytes = _encode_wav_pcm16_bytes(guide_upload, sr_out)
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
                dur=eff_dur + eff_pad_tail,
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
        cache_params = {
            'guide_pcm16_sha256': guide_digest,
            'prompt': norm_prompt,
            'lyrics': norm_lyrics,
            'cover_strength': round(float(cover_strength), 4),
            'steps': int(steps),
            'guidance_scale': round(float(guidance_scale), 3),
            'seed': int(seed),
            'dur': round(eff_dur, 4),
            'model': 'acestep-1.5',
        }

    if raw_gen.shape[1] == 1:
        raw_gen = np.concatenate([raw_gen, raw_gen], axis=1)
    elif raw_gen.shape[1] > 2:
        raw_gen = raw_gen[:, :2]
    if int(gen_sr) != sr_out and len(raw_gen) > 0:
        raw_gen = soxr.resample(raw_gen, int(gen_sr), sr_out)

    align_info = None
    if align_guide and len(raw_gen) > 0:
        raw_gen, align_info = align_cover_pitch_locked(raw_gen, guide_fitted, sr=sr_out)
        cache_params['alignment'] = align_info

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
            'params': cache_params,
            'aigc': dict(default_aigc),
        })
        if target_out:
            _copy_atomic(cache_wav, target_out)
        final_path = target_out or cache_wav
    else:
        if target_out:
            _write_wav_atomic(target_out, final_st, sr_out)
        final_path = target_out

    ret_doc = {
        'path': final_path,
        'cache': 'miss',
        'key': cache_key,
        'duration': eff_dur,
        'samples': n_target,
        'lufs': lufs_val,
        'aigc': dict(default_aigc),
    }
    if align_info is not None:
        ret_doc['alignment'] = align_info
    return ret_doc


def probe_endpoint(
    *,
    endpoint: str = None,
    ssh_host: str = None,
    remote_port: int = 8001,
    provider: str = 'acestep',
    timeout_s: float = 10.0,
) -> dict:
    """探测 ACE-Step 1.5 或 Suno MCP 服务端是否在线可达；不可达时抛退出码 3 的 CliError。"""
    prov = (provider or 'acestep').strip().lower()
    if prov not in ('acestep', 'suno'):
        raise CliError(
            'usage.bad-value',
            f'probe 不支持服务类型 {provider!r}',
            hint='可选：acestep 或 suno',
        )

    t_budget = max(1.0, float(timeout_s))
    if prov == 'suno':
        mcp_url = _resolve_suno_mcp_url(endpoint)
        sess = _SunoMcpSession(mcp_url, timeout_s=min(12.0, t_budget))
        init_res = sess.initialize(timeout_s=min(10.0, t_budget))
        usage = sess.call_tool('account-usage', {}, timeout_s=min(10.0, t_budget), unreachable_exit3=True)
        usage_doc = usage if isinstance(usage, dict) else {}
        acct = usage_doc.get('suno_account') if isinstance(usage_doc.get('suno_account'), dict) else {}
        allowed_models = list(usage_doc.get('allowed_models') or acct.get('allowed_models') or [])
        credits_remaining = usage_doc.get('credits_remaining')
        if credits_remaining is None:
            credits_remaining = acct.get('credits_remaining')
        download_credits_remaining = usage_doc.get('download_credits_remaining')
        if download_credits_remaining is None:
            download_credits_remaining = acct.get('download_credits_remaining')
        plan = usage_doc.get('plan') if usage_doc.get('plan') is not None else acct.get('plan')
        server_info = sess.server_info or (init_res.get('serverInfo') if isinstance(init_res, dict) else None)
        return {
            'ok': True,
            'online': True,
            'provider': 'suno',
            'endpoint': mcp_url,
            'serverInfo': server_info,
            'allowed_models': allowed_models,
            'credits_remaining': credits_remaining,
            'download_credits_remaining': download_credits_remaining,
            'plan': plan,
        }

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
    style = plan.get('style') or COMP.infer_composer_style('', scale=scale)
    moods = ' -> '.join(dict.fromkeys(s['mood'] for s in (plan.get('sections') or [])))
    style_desc = {
        'chinese_chamber': f'Chinese traditional chamber ensemble in {key} {scale}, {bpm} BPM, expressive dizi bamboo flute, solo guzheng, warm pipa and sheng',
        'ink_poetic': f'Poetic Eastern ink-wash chamber score in {key} {scale}, {bpm} BPM, silk-string guqin, warm xiao flute, spacious acoustic resonance',
        'anime_nostalgic': f'Nostalgic anime film soundtrack in {key} {scale}, {bpm} BPM, felt acoustic piano, lush orchestral strings, concert harp',
        'hitech_minimal': f'Modern minimalist precision film score in {key} {scale}, {bpm} BPM, felt piano, warm cello, marimba pulse, clean studio acoustics',
        'playful_folk': f'Playful acoustic folk chamber soundtrack in {key} {scale}, {bpm} BPM, warm marimba, pizzicato strings, concert flute and harp',
    }.get(style, f'cinematic orchestral soundtrack in {key} {scale}, {bpm} BPM, warm cello and string ensemble, concert harp arpeggios')
    return (
        f'{style_desc}, expressive narrative arc ({moods}) '
        f'building to soaring finale, high-fidelity studio acoustic recording, instrumental only, no vocals'
    )


def make_parser() -> ArgumentParser:
    p = ArgumentParser(
        prog='python -m engine.audio.music_gen',
        description=(
            '情绪导引乐谱与 ACE-Step 1.5 / Suno v6 Cover 配乐生成：'
            'guide 合成程序化导引轨；build 生成 Cover 配乐（或 guide 离线确定性轨）；probe 探测服务连通性。'
        ),
    )
    p.add_argument('action', choices=['guide', 'build', 'probe'], help='guide 合成导引轨；build 生成配乐；probe 探测 ACE-Step / Suno MCP 连通性')
    p.add_argument('film', nargs='?', help='作品目录或 film.json（probe 可省略；build 给了 --guide 时也可省略）')
    p.add_argument('--out', help='输出 WAV 路径（默认 <作品>/out/music/guide.wav 或 music.wav）')
    p.add_argument('--midi-out', default=None, help='可选导出标准 SMF Type-1 多轨 MIDI 文件路径（.mid）')
    p.add_argument('--key', help='调性主音（默认读作品配置，缺省 D）')
    p.add_argument('--scale', help='音阶类型（major / minor / dorian / mixolydian / lydian / pentatonic / minor-pentatonic，默认 major）')
    p.add_argument('--bpm', type=float, help='节拍速度 BPM（默认读作品配置，缺省 96）')
    p.add_argument('--style', choices=list(COMP.COMPOSER_STYLES), default=None, help='作曲风格原型（cinematic_orchestral / chinese_chamber / anime_nostalgic / hitech_minimal / ink_poetic / playful_folk）')
    p.add_argument('--dur', type=float, help='显式指定配乐时长（秒；没有 film.json 时使用）')
    p.add_argument('--pad-tail', type=float, default=0.0, help='Cover 上传前延续片尾主和弦余韵的秒数（如 4.0，防 AI Cover 提前淡出，下载后精裁回片长）')
    p.add_argument('--align-guide', action='store_true', help='显式启用零跑调（0.0 cents）锁相声码器 Cover 拍点对齐')
    p.add_argument('--prompt', help='音乐风格与配器提示词（省略时按作品调性与叙事段落自动生成纯器乐提示词）')
    p.add_argument('--lyrics', default='[inst]', help='歌词或纯器乐标记（默认 [inst]；Suno 纯器乐自动省略 lyrics）')
    p.add_argument('--guide', help='build 使用的外部导引轨 WAV（省略时自动从 film.json 合成导引轨）')
    p.add_argument('--cache', help='配乐缓存目录（默认 <作品>/out/cache/music）')
    p.add_argument('--provider', choices=['acestep', 'suno', 'guide'], default='acestep', help='生成服务：acestep（ACE-Step 1.5 Cover）、suno（本地 Magpie Suno MCP Cover）或 guide（离线确定性导引轨）')
    p.add_argument('--model', default=None, help='Suno 生成模型标签（默认 v6；仅 --provider suno 使用）')
    p.add_argument('--negative-style', default=None, help='Suno 反向排除风格标签（仅 --provider suno 使用）')
    p.add_argument('--endpoint', help='服务端地址（acestep 读 BEIMING_ACESTEP_URL；suno 默认 http://127.0.0.1:3425/mcp/suno 或读 BEIMING_SUNO_MCP_URL）')
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
            provider=args.provider,
            timeout_s=t_probe,
        )
        if args.provider == 'suno':
            srv_name = (res.get('serverInfo') or {}).get('name') or 'Suno'
            models = ','.join(res.get('allowed_models') or []) or '-'
            ctx.out(f"Suno MCP 在线可达（{srv_name}，模型={models}，剩余积分={res.get('credits_remaining')}）")
        else:
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
            style=args.style,
            prompt=args.prompt or '',
            midi_out=args.midi_out,
            pad_tail_s=args.pad_tail,
            sr=SR,
            seed=args.seed,
        )
        fdir = _base_film_dir(args.film)
        out_path = os.path.abspath(args.out or (os.path.join(fdir, 'out', 'music', 'guide.wav') if fdir else os.path.join('out', 'music', 'guide.wav')))
        _write_wav_atomic(out_path, guide_st, SR)
        wav_sha = sha256_file(out_path)
        ctx.out(
            f"导引乐谱已生成：{rel(out_path)}（{meta['dur']:.3f}s，{meta['samples']} 样本，{meta['key']} {meta['scale']}，"
            f"风格={meta['style']}，{meta['bpm']:.0f} BPM，{len(meta['sections'])} 段）"
        )
        outputs = [{'path': rel(out_path), 'sha256': wav_sha, 'kind': 'audio'}]
        if args.midi_out and os.path.isfile(args.midi_out):
            outputs.append({'path': rel(os.path.abspath(args.midi_out)), 'sha256': sha256_file(args.midi_out), 'kind': 'midi'})
        data = dict(meta, path=rel(out_path))
        return {
            'data': data,
            'outputs': outputs,
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
    eff_pad_tail = float(args.pad_tail if args.pad_tail else (music_cfg.get('pad_tail_s') or 0.0))
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
            style=args.style or music_cfg.get('style'),
            prompt=args.prompt or str(music_cfg.get('prompt') or ''),
            midi_out=args.midi_out,
            pad_tail_s=eff_pad_tail if args.provider in ('suno', 'acestep') else 0.0,
            sr=SR,
            seed=args.seed,
        )
        guide_out = os.path.join(os.path.dirname(out_path), 'guide.wav')
        if os.path.abspath(guide_out) != out_path:
            n_base = max(2, int(round(guide_meta['dur'] * SR)))
            _write_wav_atomic(guide_out, guide_st[:n_base], SR)
            outputs.append({'path': rel(guide_out), 'sha256': sha256_file(guide_out), 'kind': 'guide'})
        if args.midi_out and os.path.isfile(args.midi_out):
            outputs.append({'path': rel(os.path.abspath(args.midi_out)), 'sha256': sha256_file(args.midi_out), 'kind': 'midi'})
        guide_src = guide_st
        target_dur = guide_meta['dur']

    eff_prompt = args.prompt or music_cfg.get('prompt') or (_default_prompt_from_plan(guide_meta or plan) if (guide_meta or plan) else 'cinematic instrumental soundtrack, warm strings and harp, no vocals')
    eff_lyrics = args.lyrics if args.lyrics != '[inst]' or not music_cfg.get('lyrics') else str(music_cfg['lyrics'])
    eff_model = args.model or music_cfg.get('model') or 'v6'
    eff_neg = args.negative_style if args.negative_style is not None else music_cfg.get('negative_style')

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
        model=eff_model,
        negative_style=eff_neg,
        align_guide=True if args.align_guide else True,
        pad_tail_s=eff_pad_tail if args.provider in ('suno', 'acestep') else 0.0,
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
