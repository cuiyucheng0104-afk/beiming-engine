# -*- coding: utf-8 -*-
"""北冥引擎 · 通用算法电影作曲与零跑调导引合成内核（engine.audio.composer，纯 NumPy/SciPy + 标准 SMF Type-1 MIDI 导出）。

解决传统程序化导引轨送入 Suno v6 / ACE-Step 1.5 Cover 时的四大顽疾：
  1. 告别原位死板柱式和弦 / 空五度持续音与微音程滑音：内置功能与调式和声语法（plan_harmonic_arc）+
     Viterbi 动态规划最小声部运动连接器（solve_voice_leading，共同音保持 0 半音跳进、级进优先、反行加分、禁平行五八度、零声部交叉）；
  2. 告别机械上下行音阶练习曲：单主题 4–6 音核心动机引擎（MotifEngine），全片围绕同一记忆动机做呈示（establishing）、
     节奏紧缩变奏与事件锁拍点缀（development）、严格调内模进抬升（rising）、挂留呼吸泛音（suspension）与八度辉煌扩充加对位副歌（climax）；
  3. 告别高潮前「间 / suspension」硬断电（-240 dBFS）：执行半终止属持续音泛音呼吸（V7sus4 / V9sus4 Fermata Breath，-26 ~ -32 dBFS）
     + 末段 0.28–0.42s 弱起竖琴/古筝上行刮奏与定音鼓/堂鼓滚奏渐强引子（Anacrusis Pickup），精准落回高潮首拍主和弦（I），
     且片尾提前 1.5–2.2s（dur >= 6s 时）完成正格/变格终止让主和弦自然余韵绽放；
  4. 100.0% 国际标准音高 A4 = 440.0 Hz（0.0 cents 零失谐），支持 pad_tail_s 延续片尾主和弦防 AI Cover 提前淡出，
     并内置零外部依赖的标准 SMF Type-1 多轨 MIDI 导出器（export_midi）。
"""
from __future__ import annotations

import math
import os
import struct
import uuid

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

from .dsp import SR, fade, make_ir, pan_lr, rng, smoothstep, undb

__all__ = [
    'COMPOSER_STYLES',
    'CHORD_QUALITIES',
    'NOTE_OFFSETS',
    'SCALES',
    'GM_PROGRAMS',
    'infer_composer_style',
    'plan_harmonic_arc',
    'solve_voice_leading',
    'voice_leading_metrics',
    'MotifEngine',
    'compose_film_score',
    'render_score_wav',
    'export_midi',
]

COMPOSER_STYLES: tuple[str, ...] = (
    'cinematic_orchestral',
    'chinese_chamber',
    'anime_nostalgic',
    'hitech_minimal',
    'ink_poetic',
    'playful_folk',
)

NOTE_OFFSETS: dict[str, int] = {
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

PITCH_CLASS_NAMES: tuple[str, ...] = ('C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')

SCALES: dict[str, tuple[int, ...]] = {
    'major': (0, 2, 4, 5, 7, 9, 11),
    'ionian': (0, 2, 4, 5, 7, 9, 11),
    'minor': (0, 2, 3, 5, 7, 8, 10),
    'aeolian': (0, 2, 3, 5, 7, 8, 10),
    'dorian': (0, 2, 3, 5, 7, 9, 10),
    'mixolydian': (0, 2, 4, 5, 7, 9, 10),
    'lydian': (0, 2, 4, 6, 7, 9, 11),
    'pentatonic': (0, 2, 4, 7, 9),
    'minor-pentatonic': (0, 3, 5, 7, 10),
    'minor_pentatonic': (0, 3, 5, 7, 10),
}

# 和弦性质音程表（相对和弦根音的半音偏移）
CHORD_QUALITIES: dict[str, tuple[int, ...]] = {
    'maj': (0, 4, 7),
    'maj7': (0, 4, 7, 11),
    'maj9': (0, 4, 7, 11, 14),
    'min': (0, 3, 7),
    'min7': (0, 3, 7, 10),
    'min9': (0, 3, 7, 10, 14),
    'dom7': (0, 4, 7, 10),
    '7sus4': (0, 5, 7, 10),
    '9sus4': (0, 5, 7, 10, 14),
    'sus4': (0, 5, 7),
    'sus2': (0, 2, 7),
    'add9': (0, 4, 7, 14),
    'min_add9': (0, 3, 7, 14),
    '69': (0, 4, 7, 9, 14),
    'pent_gong': (0, 4, 7, 9, 14),
    'pent_yu': (0, 3, 7, 10, 14),
    'pent_zhi_sus': (0, 5, 7, 9, 14),
}

# 各风格对应的 General MIDI 音色程序号（0..127）与内部合成器音色名
_STYLE_ORCHESTRATION: dict[str, dict] = {
    'cinematic_orchestral': {
        'harmony_timbre': 'strings',
        'bass_timbre': 'cello',
        'melody_timbre': 'horn_strings',
        'counter_timbre': 'flute',
        'arp_timbre': 'harp',
        'perc_timbre': 'timpani',
        'gm': {'harmony': 48, 'bass': 42, 'melody': 60, 'arpeggio': 46, 'percussion': 47},
        'reverb_rt': 1.65,
        'reverb_wet': 0.24,
    },
    'chinese_chamber': {
        'harmony_timbre': 'sheng',
        'bass_timbre': 'cello',
        'melody_timbre': 'dizi',
        'counter_timbre': 'pipa',
        'arp_timbre': 'guzheng',
        'perc_timbre': 'tanggu',
        'gm': {'harmony': 22, 'bass': 42, 'melody': 73, 'arpeggio': 107, 'percussion': 47},
        'reverb_rt': 1.38,
        'reverb_wet': 0.21,
    },
    'anime_nostalgic': {
        'harmony_timbre': 'strings',
        'bass_timbre': 'cello',
        'melody_timbre': 'felt_piano',
        'counter_timbre': 'flute',
        'arp_timbre': 'felt_piano',
        'perc_timbre': 'timpani',
        'gm': {'harmony': 48, 'bass': 42, 'melody': 0, 'arpeggio': 46, 'percussion': 47},
        'reverb_rt': 1.55,
        'reverb_wet': 0.23,
    },
    'hitech_minimal': {
        'harmony_timbre': 'glass_pad',
        'bass_timbre': 'cello',
        'melody_timbre': 'felt_piano',
        'counter_timbre': 'marimba',
        'arp_timbre': 'marimba',
        'perc_timbre': 'timpani',
        'gm': {'harmony': 89, 'bass': 42, 'melody': 4, 'arpeggio': 12, 'percussion': 47},
        'reverb_rt': 1.25,
        'reverb_wet': 0.18,
    },
    'ink_poetic': {
        'harmony_timbre': 'sheng',
        'bass_timbre': 'cello',
        'melody_timbre': 'xiao',
        'counter_timbre': 'guqin',
        'arp_timbre': 'guqin',
        'perc_timbre': 'tanggu',
        'gm': {'harmony': 48, 'bass': 42, 'melody': 77, 'arpeggio': 107, 'percussion': 47},
        'reverb_rt': 1.85,
        'reverb_wet': 0.27,
    },
    'playful_folk': {
        'harmony_timbre': 'strings',
        'bass_timbre': 'pizz_bass',
        'melody_timbre': 'flute',
        'counter_timbre': 'marimba',
        'arp_timbre': 'marimba',
        'perc_timbre': 'tanggu',
        'gm': {'harmony': 45, 'bass': 43, 'melody': 73, 'arpeggio': 12, 'percussion': 47},
        'reverb_rt': 1.15,
        'reverb_wet': 0.17,
    },
}

GM_PROGRAMS: dict[str, dict[str, int]] = {k: dict(v['gm']) for k, v in _STYLE_ORCHESTRATION.items()}


def midi_to_hz(midi_note: int | float) -> float:
    """严格十二平均律国际标准音高 A4 = 440.0 Hz（0.0 cents 失谐）。"""
    return 440.0 * (2.0 ** ((float(midi_note) - 69.0) / 12.0))


def normalize_key_and_scale(key: str | None = 'D', scale: str | None = 'major') -> tuple[str, str]:
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
        raise ValueError(f'不认识的调性主音：{key!r}')
    if not raw_s:
        raw_s = 'major'
    if raw_s not in SCALES:
        raise ValueError(f'不认识的音阶类型：{scale!r}')
    return norm_k, raw_s


def infer_composer_style(prompt: str = '', world: str | None = None, scale: str | None = None) -> str:
    """根据提示词、世界观（world）与音阶（scale）自动推断最契合的作曲风格原型。"""
    p = (prompt or '').strip().lower()
    w = (world or '').strip().lower()
    s = (scale or '').strip().lower()

    if any(tok in p for tok in ('ink', 'guqin', 'xiao', 'zen', 'meditative', 'misty', '水墨', '写意', '古琴', '洞箫', '箫', '空山', '禅')):
        return 'ink_poetic'
    if any(tok in p for tok in (
        'guzheng', 'pipa', 'dizi', 'erhu', 'sheng', 'chinese', 'oriental', 'tanggu', 'papercut',
        '古筝', '琵琶', '竹笛', '笛', '二胡', '笙', '民乐', '国风', '剪纸', '喜庆', '春',
    )):
        return 'chinese_chamber'
    if any(tok in p for tok in (
        'anime', 'ghibli', 'hisaishi', 'shinkai', 'nostalgic', 'youth', 'royal road',
        '日系', '治愈', '青春', '久石让', '新海诚', '夏日', '怀旧',
    )):
        return 'anime_nostalgic'
    if any(tok in p for tok in (
        'hitech', 'hi-tech', 'minimal', 'cyber', 'hud', 'telemetry', 'precision', 'techno', 'pulse',
        '高科技', '极简', '精密', '拆解', '数据', '科幻',
    )):
        return 'hitech_minimal'
    if any(tok in p for tok in (
        'playful', 'folk', 'marimba', 'pizzicato', 'ukulele', 'cartoon', 'whimsical', 'cheerful',
        '轻快', '童趣', '木琴', '拨弦', '田园', '卡通', '欢快',
    )):
        return 'playful_folk'

    if w == 'poetic':
        return 'ink_poetic'
    if w in ('hitech', 'scifi'):
        return 'hitech_minimal'
    if w in ('cartoon', 'semi_realistic'):
        return 'playful_folk'
    if s in ('pentatonic', 'minor-pentatonic', 'minor_pentatonic'):
        return 'chinese_chamber'
    return 'cinematic_orchestral'


def _is_minor_family(scale: str) -> bool:
    return scale in ('minor', 'aeolian', 'dorian', 'minor-pentatonic', 'minor_pentatonic')


def _is_pentatonic_family(scale: str) -> bool:
    return scale in ('pentatonic', 'minor-pentatonic', 'minor_pentatonic')


# 每项模板：(根音相对主音半音偏移, quality, 低音相对和弦根音半音偏移, 音级度数1..7, 功能标签)
def _style_Templates(style: str, is_minor: bool) -> dict[str, list[tuple[int, str, int, int, str]]]:
    if style == 'chinese_chamber':
        if is_minor:
            # 羽调式（如 D 羽：D - F - G - A - C）：羽 -> 宫 -> 角/下属 -> 徵挂留
            return {
                'establishing': [
                    (0, 'pent_yu', 0, 1, 'T'),
                    (3, 'pent_gong', 0, 3, 'M'),
                    (5, 'min7', 0, 4, 'SD'),
                    (7, 'pent_zhi_sus', 0, 5, 'D_sus'),
                ],
                'development': [
                    (5, 'min7', 0, 4, 'SD'),
                    (10, '69', 0, 7, 'SD'),
                    (3, 'pent_gong', 0, 3, 'M'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'rising': [
                    (5, 'min7', 0, 4, 'SD'),
                    (10, 'add9', 0, 7, 'SD'),
                    (3, 'pent_gong', 0, 3, 'M'),
                    (7, '9sus4', 0, 5, 'D_sus'),
                ],
                'suspension': [
                    (5, 'min7', 0, 4, 'SD'),
                    (7, '9sus4', 0, 5, 'D_pedal'),
                ],
                'climax_open': (0, 'min_add9', 0, 1, 'T'),
                'climax_mid': [
                    (3, 'pent_gong', 0, 3, 'M'),
                    (5, 'min7', 0, 4, 'SD'),
                    (7, '7sus4', 0, 5, 'D'),
                ],
                'climax_cadence': (7, '7sus4', 0, 5, 'D'),
                'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
            }
        # 宫调式（如 D 宫：D(宫) -> Bm7(羽) -> G6/9(下属宫) -> A9sus4(徵挂留)）
        return {
            'establishing': [
                (0, 'pent_gong', 0, 1, 'T'),
                (9, 'pent_yu', 0, 6, 'SM'),
                (5, '69', 0, 4, 'SD'),
                (7, 'pent_zhi_sus', 0, 5, 'D_sus'),
            ],
            'development': [
                (5, '69', 0, 4, 'SD'),
                (7, 'pent_zhi_sus', 0, 5, 'D_sus'),
                (9, 'pent_yu', 0, 6, 'SM'),
                (4, 'min7', 0, 3, 'M'),
            ],
            'rising': [
                (2, 'min7', 0, 2, 'SD'),
                (4, 'min7', 0, 3, 'M'),
                (5, '69', 0, 4, 'SD'),
                (7, '9sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (5, '69', 0, 4, 'SD'),
                (7, '9sus4', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'pent_gong', 0, 1, 'T'),
            'climax_mid': [
                (9, 'pent_yu', 0, 6, 'SM'),
                (5, '69', 0, 4, 'SD'),
                (7, 'pent_zhi_sus', 0, 5, 'D'),
            ],
            'climax_cadence': (5, '69', 0, 4, 'SD_plagal'),
            'final_tonic': (0, 'pent_gong', 0, 1, 'T_final'),
        }

    if style == 'ink_poetic':
        if is_minor:
            return {
                'establishing': [
                    (0, 'min9', 0, 1, 'T'),
                    (3, 'maj7', 0, 3, 'M'),
                    (5, 'min7', 0, 4, 'SD'),
                    (0, 'min_add9', 0, 1, 'T'),
                ],
                'development': [
                    (5, 'min9', 0, 4, 'SD'),
                    (10, '69', 0, 7, 'SD'),
                    (3, 'maj9', 0, 3, 'M'),
                    (7, '9sus4', 0, 5, 'D_sus'),
                ],
                'rising': [
                    (5, 'min7', 0, 4, 'SD'),
                    (8, 'maj7', 0, 6, 'SM'),
                    (10, '69', 0, 7, 'SD'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'suspension': [
                    (7, '9sus4', 0, 5, 'D_pedal'),
                ],
                'climax_open': (0, 'min_add9', 0, 1, 'T'),
                'climax_mid': [
                    (8, 'maj7', 0, 6, 'SM'),
                    (5, 'min7', 0, 4, 'SD'),
                ],
                'climax_cadence': (5, 'min7', 0, 4, 'SD_plagal'),
                'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
            }
        return {
            'establishing': [
                (0, 'pent_gong', 0, 1, 'T'),
                (9, 'pent_yu', 0, 6, 'SM'),
                (5, '69', 0, 4, 'SD'),
                (0, 'add9', 0, 1, 'T'),
            ],
            'development': [
                (9, 'pent_yu', 0, 6, 'SM'),
                (4, 'min7', 0, 3, 'M'),
                (5, '69', 0, 4, 'SD'),
                (7, 'pent_zhi_sus', 0, 5, 'D_sus'),
            ],
            'rising': [
                (2, 'min7', 0, 2, 'SD'),
                (5, '69', 0, 4, 'SD'),
                (9, 'pent_yu', 0, 6, 'SM'),
                (7, '9sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (7, 'pent_zhi_sus', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'pent_gong', 0, 1, 'T'),
            'climax_mid': [
                (9, 'pent_yu', 0, 6, 'SM'),
                (5, '69', 0, 4, 'SD'),
            ],
            'climax_cadence': (5, '69', 0, 4, 'SD_plagal'),
            'final_tonic': (0, 'pent_gong', 0, 1, 'T_final'),
        }

    if style == 'anime_nostalgic':
        # 王道进行（Royal Road：IVmaj7 -> V7 -> iii7 -> vi7）+ 温暖加九主和弦归宿
        if is_minor:
            return {
                'establishing': [
                    (8, 'maj7', 0, 6, 'SD'),
                    (10, 'dom7', 0, 7, 'D'),
                    (7, 'min7', 0, 5, 'M'),
                    (0, 'min9', 0, 1, 'T'),
                ],
                'development': [
                    (5, 'min9', 0, 4, 'SD'),
                    (10, 'dom7', 0, 7, 'D'),
                    (3, 'maj9', 0, 3, 'M'),
                    (8, 'maj7', 0, 6, 'SM'),
                ],
                'rising': [
                    (5, 'min7', 0, 4, 'SD'),
                    (7, 'dom7', 0, 5, 'D'),
                    (8, 'maj7', 0, 6, 'SM'),
                    (7, '9sus4', 0, 5, 'D_sus'),
                ],
                'suspension': [
                    (8, 'maj7', 0, 6, 'SD'),
                    (7, '9sus4', 0, 5, 'D_pedal'),
                ],
                'climax_open': (0, 'min_add9', 0, 1, 'T'),
                'climax_mid': [
                    (8, 'maj7', 0, 6, 'SD'),
                    (10, 'dom7', 0, 7, 'D'),
                    (3, 'maj7', 0, 3, 'M'),
                ],
                'climax_cadence': (7, 'dom7', 0, 5, 'D'),
                'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
            }
        return {
            'establishing': [
                (5, 'maj7', 0, 4, 'SD'),
                (7, 'dom7', 0, 5, 'D'),
                (4, 'min7', 0, 3, 'M'),
                (9, 'min7', 0, 6, 'SM'),
            ],
            'development': [
                (2, 'min9', 0, 2, 'SD'),
                (7, '9sus4', 0, 5, 'D_sus'),
                (0, 'maj9', 0, 1, 'T'),
                (9, 'min7', 0, 6, 'SM'),
            ],
            'rising': [
                (5, 'maj7', 0, 4, 'SD'),
                (7, 'dom7', 0, 5, 'D'),
                (4, 'min7', 0, 3, 'M'),
                (7, '9sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (2, 'min7', 0, 2, 'SD'),
                (7, '9sus4', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'add9', 0, 1, 'T'),
            'climax_mid': [
                (5, 'maj7', 0, 4, 'SD'),
                (7, 'dom7', 0, 5, 'D'),
                (4, 'min7', 0, 3, 'M'),
                (9, 'min7', 0, 6, 'SM'),
            ],
            'climax_cadence': (5, 'maj7', 0, 4, 'SD_plagal'),
            'final_tonic': (0, 'add9', 0, 1, 'T_final'),
        }

    if style == 'hitech_minimal':
        if is_minor:
            return {
                'establishing': [
                    (0, 'min9', 0, 1, 'T'),
                    (8, 'maj9', 0, 6, 'SM'),
                    (5, 'min7', 0, 4, 'SD'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'development': [
                    (5, 'min9', 0, 4, 'SD'),
                    (3, 'maj7', 0, 3, 'M'),
                    (10, 'add9', 0, 7, 'SD'),
                    (7, '9sus4', 0, 5, 'D_sus'),
                ],
                'rising': [
                    (5, 'min7', 0, 4, 'SD'),
                    (8, 'maj7', 0, 6, 'SM'),
                    (10, '69', 0, 7, 'SD'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'suspension': [
                    (7, '9sus4', 0, 5, 'D_pedal'),
                ],
                'climax_open': (0, 'min_add9', 0, 1, 'T'),
                'climax_mid': [
                    (8, 'maj7', 0, 6, 'SM'),
                    (10, 'add9', 0, 7, 'SD'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'climax_cadence': (7, '7sus4', 0, 5, 'D'),
                'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
            }
        return {
            'establishing': [
                (0, 'add9', 0, 1, 'T'),
                (9, 'min7', 0, 6, 'SM'),
                (5, 'maj9', 0, 4, 'SD'),
                (7, '7sus4', 0, 5, 'D_sus'),
            ],
            'development': [
                (9, 'min9', 0, 6, 'SM'),
                (5, 'maj7', 0, 4, 'SD'),
                (0, 'add9', 0, 1, 'T'),
                (7, '9sus4', 0, 5, 'D_sus'),
            ],
            'rising': [
                (2, 'min7', 0, 2, 'SD'),
                (5, 'maj7', 0, 4, 'SD'),
                (9, 'min7', 0, 6, 'SM'),
                (7, '7sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (7, '9sus4', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'add9', 0, 1, 'T'),
            'climax_mid': [
                (7, '7sus4', 0, 5, 'D_sus'),
                (9, 'min7', 0, 6, 'SM'),
                (5, 'maj7', 0, 4, 'SD'),
            ],
            'climax_cadence': (5, 'maj7', 0, 4, 'SD_plagal'),
            'final_tonic': (0, 'add9', 0, 1, 'T_final'),
        }

    if style == 'playful_folk':
        if is_minor:
            return {
                'establishing': [
                    (0, 'min7', 0, 1, 'T'),
                    (3, 'add9', 0, 3, 'M'),
                    (5, 'min7', 0, 4, 'SD'),
                    (10, 'dom7', 0, 7, 'D'),
                ],
                'development': [
                    (5, 'min7', 0, 4, 'SD'),
                    (10, 'dom7', 0, 7, 'D'),
                    (3, 'add9', 0, 3, 'M'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                ],
                'rising': [
                    (5, 'min7', 0, 4, 'SD'),
                    (8, 'maj7', 0, 6, 'SM'),
                    (7, '7sus4', 0, 5, 'D_sus'),
                    (7, 'dom7', 0, 5, 'D'),
                ],
                'suspension': [
                    (7, '7sus4', 0, 5, 'D_pedal'),
                ],
                'climax_open': (0, 'min_add9', 0, 1, 'T'),
                'climax_mid': [
                    (3, 'add9', 0, 3, 'M'),
                    (5, 'min7', 0, 4, 'SD'),
                ],
                'climax_cadence': (7, 'dom7', 0, 5, 'D'),
                'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
            }
        return {
            'establishing': [
                (0, 'add9', 0, 1, 'T'),
                (7, 'maj', 4, 5, 'D6'),
                (9, 'min7', 0, 6, 'SM'),
                (5, '69', 0, 4, 'SD'),
            ],
            'development': [
                (5, '69', 0, 4, 'SD'),
                (0, 'add9', 4, 1, 'T6'),
                (2, 'min7', 0, 2, 'SD'),
                (7, 'dom7', 0, 5, 'D'),
            ],
            'rising': [
                (2, 'min7', 0, 2, 'SD'),
                (0, 'maj', 4, 1, 'T6'),
                (5, '69', 0, 4, 'SD'),
                (7, '7sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (5, '69', 0, 4, 'SD'),
                (7, '7sus4', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'add9', 0, 1, 'T'),
            'climax_mid': [
                (5, '69', 0, 4, 'SD'),
                (9, 'min7', 0, 6, 'SM'),
                (2, 'min7', 0, 2, 'SD'),
            ],
            'climax_cadence': (7, 'dom7', 0, 5, 'D'),
            'final_tonic': (0, 'add9', 0, 1, 'T_final'),
        }

    # 默认：cinematic_orchestral（好莱坞/欧洲管弦电影配乐语法，含第一转位低音步进）
    if is_minor:
        return {
            'establishing': [
                (0, 'min9', 0, 1, 'T'),
                (8, 'maj7', 0, 6, 'SM'),
                (3, 'add9', 0, 3, 'M'),
                (10, 'dom7', 0, 7, 'D'),
            ],
            'development': [
                (5, 'min7', 0, 4, 'SD'),
                (10, 'dom7', 0, 7, 'D'),
                (3, 'maj7', 0, 3, 'M'),
                (8, 'maj7', 0, 6, 'SM'),
            ],
            'rising': [
                (5, 'min7', 0, 4, 'SD'),
                (0, 'min', 3, 1, 'T6'),
                (8, 'maj7', 0, 6, 'SM'),
                (7, '7sus4', 0, 5, 'D_sus'),
            ],
            'suspension': [
                (8, 'maj7', 0, 6, 'SD'),
                (7, '9sus4', 0, 5, 'D_pedal'),
            ],
            'climax_open': (0, 'min_add9', 0, 1, 'T'),
            'climax_mid': [
                (8, 'maj7', 0, 6, 'SM'),
                (3, 'add9', 0, 3, 'M'),
                (10, 'maj', 0, 7, 'D'),
            ],
            'climax_cadence': (7, 'dom7', 0, 5, 'D_authentic'),
            'final_tonic': (0, 'min_add9', 0, 1, 'T_final'),
        }
    return {
        'establishing': [
            (0, 'add9', 0, 1, 'T'),
            (7, 'maj', 4, 5, 'D6'),
            (9, 'min7', 0, 6, 'SM'),
            (5, 'maj7', 0, 4, 'SD'),
        ],
        'development': [
            (5, 'maj7', 0, 4, 'SD'),
            (0, 'maj', 4, 1, 'T6'),
            (2, 'min7', 0, 2, 'SD'),
            (7, '7sus4', 0, 5, 'D_sus'),
        ],
        'rising': [
            (2, 'min7', 0, 2, 'SD'),
            (0, 'maj', 4, 1, 'T6'),
            (5, 'maj7', 0, 4, 'SD'),
            (7, 'dom7', 0, 5, 'D'),
        ],
        'suspension': [
            (5, 'maj7', 0, 4, 'SD'),
            (7, '9sus4', 0, 5, 'D_pedal'),
        ],
        'climax_open': (0, 'add9', 0, 1, 'T'),
        'climax_mid': [
            (9, 'min7', 0, 6, 'SM'),
            (5, 'maj7', 0, 4, 'SD'),
            (2, 'min7', 0, 2, 'SD'),
        ],
        'climax_cadence': (7, 'dom7', 0, 5, 'D_authentic'),
        'final_tonic': (0, 'add9', 0, 1, 'T_final'),
    }


def _make_chord_dict(
    *,
    index: int,
    sec: dict,
    t0: float,
    t1: float,
    tonic_pc: int,
    rel_semi: int,
    quality: str,
    bass_rel_to_root: int,
    degree: int,
    func_tag: str,
    cadence: str | None = None,
) -> dict:
    if quality not in CHORD_QUALITIES:
        quality = 'add9'
    root_pc = (tonic_pc + int(rel_semi)) % 12
    bass_pc = (root_pc + int(bass_rel_to_root)) % 12
    iv = CHORD_QUALITIES[quality]
    pcs = tuple(dict.fromkeys((root_pc + s) % 12 for s in iv))
    rname = PITCH_CLASS_NAMES[root_pc]
    bname = PITCH_CLASS_NAMES[bass_pc]
    sym = f'{rname}({quality})' if quality.startswith('pent_') else f'{rname}{"" if quality == "maj" else ("m" if quality == "min" else quality)}'
    if bass_pc != root_pc:
        sym = f'{sym}/{bname}'
    return {
        'index': int(index),
        'section_id': str(sec['id']),
        'mood': str(sec['mood']),
        't0': round(float(t0), 6),
        't1': round(float(t1), 6),
        'energy': float(sec['energy']),
        'degree': int(degree),
        'root_pc': int(root_pc),
        'bass_pc': int(bass_pc),
        'quality': quality,
        'intervals': iv,
        'pitch_classes': pcs,
        'symbol': sym,
        'function': func_tag,
        'cadence': cadence,
    }


def plan_harmonic_arc(
    sections: list[dict],
    *,
    key: str = 'D',
    scale: str = 'major',
    style: str = 'cinematic_orchestral',
    bpm: float = 96.0,
    dur: float | None = None,
) -> list[dict]:
    """根据叙事分段规划功能/调式和声弧线与终止式语法（Cadence Grammar）。"""
    norm_key, norm_scale = normalize_key_and_scale(key, scale)
    eff_style = style if style in COMPOSER_STYLES else infer_composer_style(style or '', scale=norm_scale)
    tonic_pc = NOTE_OFFSETS[norm_key.upper()]
    is_min = _is_minor_family(norm_scale)
    tmpl = _style_Templates(eff_style, is_min)
    spb = 60.0 / max(20.0, float(bpm))
    slot_target = max(0.85, 2.0 * spb)

    if not sections:
        total_d = float(dur or 8.0)
        sections = [
            {'id': 'S1_intro', 't0': 0.0, 't1': 0.5 * total_d, 'energy': 0.35, 'mood': 'establishing'},
            {'id': 'S2_climax', 't0': 0.5 * total_d, 't1': total_d, 'energy': 0.92, 'mood': 'climax'},
        ]

    total_dur = float(dur if dur is not None else max(float(s['t1']) for s in sections))
    chords: list[dict] = []

    for s_idx, raw_s in enumerate(sections):
        t0 = float(raw_s['t0'])
        t1 = float(raw_s['t1'])
        if t1 <= t0 + 1e-6:
            continue
        sec_dur = t1 - t0
        mood = str(raw_s.get('mood') or 'development').lower()
        is_last_sec = (s_idx == len(sections) - 1)
        is_susp = mood in ('suspension', 'silence', 'breath')
        sec = {
            'id': str(raw_s.get('id') or f'sec_{s_idx + 1}'),
            't0': t0,
            't1': t1,
            'energy': float(np.clip(raw_s.get('energy', 0.42 if is_susp else 0.58), 0.12, 1.0)),
            'mood': 'suspension' if is_susp else mood,
        }

        if is_susp:
            # 呼吸悬停段：强制落定在半终止属持续音（Half Cadence / Dominant Pedal：V7sus4 / V9sus4）
            susp_seq = tmpl['suspension']
            if sec_dur >= 2.2 and len(susp_seq) >= 2:
                split_t = t0 + 0.38 * sec_dur
                c0 = susp_seq[0]
                c1 = susp_seq[-1]
                chords.append(_make_chord_dict(
                    index=len(chords), sec=sec, t0=t0, t1=split_t, tonic_pc=tonic_pc,
                    rel_semi=c0[0], quality=c0[1], bass_rel_to_root=c0[2], degree=c0[3],
                    func_tag=c0[4], cadence='pre_suspension',
                ))
                chords.append(_make_chord_dict(
                    index=len(chords), sec=sec, t0=split_t, t1=t1, tonic_pc=tonic_pc,
                    rel_semi=c1[0], quality=c1[1], bass_rel_to_root=c1[2], degree=c1[3],
                    func_tag=c1[4], cadence='half_pedal',
                ))
            else:
                c1 = susp_seq[-1]
                chords.append(_make_chord_dict(
                    index=len(chords), sec=sec, t0=t0, t1=t1, tonic_pc=tonic_pc,
                    rel_semi=c1[0], quality=c1[1], bass_rel_to_root=c1[2], degree=c1[3],
                    func_tag=c1[4], cadence='half_pedal',
                ))
            continue

        if is_last_sec or mood == 'climax':
            # 高潮段与终章终止式：
            # 1) t0 首拍必落回辉煌主和弦 Tonic（承接上一镜属挂留与弱起引子的正格解决！）
            # 2) 若全片 dur >= 6.0s，最终主和弦在距片尾 1.5–2.2s 处落定并自然延续余韵，绝不在最后一刻硬切半句！
            open_c = tmpl['climax_open']
            cad_c = tmpl['climax_cadence']
            fin_c = tmpl['final_tonic']
            mid_pool = tmpl['climax_mid']

            if is_last_sec and total_dur >= 6.0:
                res_tail = float(np.clip(0.26 * sec_dur, 1.55, 2.15))
                if sec_dur >= res_tail + 1.10:
                    t_final = t1 - res_tail
                    pre_span = t_final - t0
                    n_pre = max(2, int(round(pre_span / max(0.75, 0.85 * slot_target))))
                    slot_w = pre_span / float(n_pre)
                    for k in range(n_pre):
                        ca = t0 + k * slot_w
                        cb = t0 + (k + 1) * slot_w if k < n_pre - 1 else t_final
                        if k == 0:
                            spec, cad_tag = open_c, 'climax_tonic_arrival'
                        elif k == n_pre - 1:
                            spec, cad_tag = cad_c, 'pre_final_cadence'
                        else:
                            spec = mid_pool[(k - 1) % len(mid_pool)]
                            cad_tag = None
                        chords.append(_make_chord_dict(
                            index=len(chords), sec=sec, t0=ca, t1=cb, tonic_pc=tonic_pc,
                            rel_semi=spec[0], quality=spec[1], bass_rel_to_root=spec[2], degree=spec[3],
                            func_tag=spec[4], cadence=cad_tag,
                        ))
                    chords.append(_make_chord_dict(
                        index=len(chords), sec=sec, t0=t_final, t1=t1, tonic_pc=tonic_pc,
                        rel_semi=fin_c[0], quality=fin_c[1], bass_rel_to_root=fin_c[2], degree=fin_c[3],
                        func_tag=fin_c[4], cadence='final_resolution',
                    ))
                    continue
                elif sec_dur >= 1.50:
                    # 高潮段本身恰好在 1.5..2.6s 之间：直接以凯旋主和弦落定并完整余韵延展至片尾
                    chords.append(_make_chord_dict(
                        index=len(chords), sec=sec, t0=t0, t1=t1, tonic_pc=tonic_pc,
                        rel_semi=fin_c[0], quality=fin_c[1], bass_rel_to_root=fin_c[2], degree=fin_c[3],
                        func_tag=fin_c[4], cadence='final_resolution',
                    ))
                    continue

            # 短片（dur < 6.0s）或非末段 climax
            n_slots = max(2, int(round(sec_dur / max(0.65, 0.85 * slot_target)))) if sec_dur >= 1.2 else 1
            slot_w = sec_dur / float(n_slots)
            for k in range(n_slots):
                ca = t0 + k * slot_w
                cb = t1 if k == n_slots - 1 else (t0 + (k + 1) * slot_w)
                if k == 0:
                    spec, cad_tag = open_c, 'climax_tonic_arrival'
                elif k == n_slots - 1 and is_last_sec:
                    spec, cad_tag = fin_c, 'final_resolution'
                elif k == n_slots - 2 and is_last_sec and n_slots >= 3:
                    spec, cad_tag = cad_c, 'pre_final_cadence'
                else:
                    spec = mid_pool[(k - 1) % len(mid_pool)]
                    cad_tag = None
                chords.append(_make_chord_dict(
                    index=len(chords), sec=sec, t0=ca, t1=cb, tonic_pc=tonic_pc,
                    rel_semi=spec[0], quality=spec[1], bass_rel_to_root=spec[2], degree=spec[3],
                    func_tag=spec[4], cadence=cad_tag,
                ))
            continue

        # establishing / development / rising 常规叙事段
        seq = tmpl.get(mood) or tmpl['development']
        n_slots = max(1, int(round(sec_dur / slot_target)))
        if sec_dur >= 1.8 and n_slots < 2:
            n_slots = 2
        slot_w = sec_dur / float(n_slots)
        for k in range(n_slots):
            ca = t0 + k * slot_w
            cb = t1 if k == n_slots - 1 else (t0 + (k + 1) * slot_w)
            spec = seq[k % len(seq)]
            cad_tag = 'section_bridge' if k == n_slots - 1 else None
            chords.append(_make_chord_dict(
                index=len(chords), sec=sec, t0=ca, t1=cb, tonic_pc=tonic_pc,
                rel_semi=spec[0], quality=spec[1], bass_rel_to_root=spec[2], degree=spec[3],
                func_tag=spec[4], cadence=cad_tag,
            ))

    if chords:
        chords[0]['t0'] = 0.0
        chords[-1]['t1'] = round(total_dur, 6)
    return chords


def _parse_chord_input(item, idx: int) -> dict:
    if isinstance(item, dict) and 'pitch_classes' in item:
        d = dict(item)
        d.setdefault('index', idx)
        d.setdefault('bass_pc', d.get('root_pc', d['pitch_classes'][0]))
        d.setdefault('energy', 0.55)
        return d
    if isinstance(item, (list, tuple)) and item:
        pcs = tuple(int(x) % 12 for x in item)
        return {
            'index': idx,
            'root_pc': pcs[0],
            'bass_pc': pcs[0],
            'pitch_classes': pcs,
            'energy': 0.55,
            'symbol': f'PC{pcs}',
        }
    raise ValueError(f'无法解析和弦项：{item!r}')


def _candidate_voicings_for_chord(
    chord: dict,
    bass_range: tuple[int, int] = (28, 48),
    upper_range: tuple[int, int] = (48, 76),
) -> list[tuple[int, int, int, int]]:
    pcs = tuple(dict.fromkeys(int(p) % 12 for p in chord['pitch_classes']))
    bass_pc = int(chord.get('bass_pc', pcs[0])) % 12
    root_pc = int(chord.get('root_pc', pcs[0])) % 12

    bass_notes = [m for m in range(bass_range[0], bass_range[1] + 1) if m % 12 == bass_pc]
    if not bass_notes:
        bass_notes = [36 + bass_pc]
    # 优先温暖饱满的大提琴低音区 D2..B2（38..47）
    pref_bass = [b for b in bass_notes if 33 <= b <= 47] or bass_notes

    upper_pitches = [m for m in range(upper_range[0], upper_range[1] + 1) if (m % 12) in pcs]
    non_root_pcs = [p for p in pcs if p != root_pc]

    triples: list[tuple[int, int, int]] = []
    n_up = len(upper_pitches)
    for i in range(n_up - 2):
        t = upper_pitches[i]
        for j in range(i + 1, n_up - 1):
            a = upper_pitches[j]
            if not (3 <= a - t <= 12):
                continue
            for k in range(j + 1, n_up):
                s = upper_pitches[k]
                if not (3 <= s - a <= 12):
                    continue
                if s - t > 19:
                    continue
                chosen_pcs = {t % 12, a % 12, s % 12}
                # 至少包含 2 个不同音级，且必须带三音/四音/七音/六音色彩（不全是纯根五空壳）
                if len(chosen_pcs) < min(2, len(pcs)):
                    continue
                if non_root_pcs and not any(p in chosen_pcs for p in non_root_pcs):
                    continue
                if len(pcs) >= 3 and len(chosen_pcs) < 2:
                    continue
                triples.append((t, a, s))

    if not triples:
        # 极端兜底
        base_t = max(upper_range[0], 50 + root_pc)
        triples = [(base_t, base_t + 4, base_t + 7)]

    cands: list[tuple[int, int, int, int]] = []
    for b in pref_bass:
        for t, a, s in triples:
            if t - b < 5:
                continue
            cands.append((b, t, a, s))
    if not cands:
        b0 = pref_bass[0]
        t0, a0, s0 = triples[0]
        while t0 <= b0:
            t0 += 12
            a0 += 12
            s0 += 12
        cands = [(b0, t0, a0, s0)]
    return cands


def solve_voice_leading(
    chords: list[dict],
    *,
    bass_range: tuple[int, int] = (28, 48),
    upper_range: tuple[int, int] = (48, 76),
) -> list[dict]:
    """Viterbi 动态规划四声部（Bass, Tenor, Alto, Soprano）最小声部运动连接器。

    硬保证：
      · 严格声部次序 Bass < Tenor < Alto < Soprano（零声部交叉）；
      · 共同音保持同 MIDI 音高（0 半音跳进奖励），1–2 半音级进强优先，> 4 半音大跳二次方重罚；
      · 严惩低音与高音声部间的平行纯五度/纯八度，奖励外声部（Bass 与 Soprano）反向进行；
      · 随段落 energy 平滑打开声部间距与高音歌唱区。
    """
    if not chords:
        return []

    parsed = [_parse_chord_input(c, idx) for idx, c in enumerate(chords)]
    cand_lists = [
        np.asarray(_candidate_voicings_for_chord(c, bass_range=bass_range, upper_range=upper_range), dtype=np.int32)
        for c in parsed
    ]

    def _state_cost(v_arr: np.ndarray, energy: float) -> np.ndarray:
        b = v_arr[:, 0].astype(np.float64)
        t = v_arr[:, 1].astype(np.float64)
        a = v_arr[:, 2].astype(np.float64)
        s = v_arr[:, 3].astype(np.float64)
        target_sop = 63.0 + 8.5 * energy
        target_spread = 9.5 + 4.5 * energy
        # 优先选择包含 3 个互异上声部音级的饱满排列
        same_ta = (v_arr[:, 1] % 12 == v_arr[:, 2] % 12).astype(np.float64)
        same_as = (v_arr[:, 2] % 12 == v_arr[:, 3] % 12).astype(np.float64)
        same_ts = (v_arr[:, 1] % 12 == v_arr[:, 3] % 12).astype(np.float64)
        dup_pen = 0.85 * (same_ta + same_as + same_ts)
        bass_pref = 0.03 * np.square(b - (40.0 - 2.0 * energy))
        return (
            0.045 * np.square(s - target_sop)
            + 0.035 * np.square((s - t) - target_spread)
            + dup_pen
            + bass_pref
        )

    m_steps = len(parsed)
    dp_costs: list[np.ndarray] = []
    backptrs: list[np.ndarray] = []

    dp0 = _state_cost(cand_lists[0], float(parsed[0].get('energy', 0.45)))
    dp_costs.append(dp0)

    for step in range(1, m_steps):
        prev_v = cand_lists[step - 1]   # (Kp, 4)
        curr_v = cand_lists[step]       # (Kc, 4)
        eng = float(parsed[step].get('energy', 0.55))
        same_chord = (
            parsed[step].get('root_pc') == parsed[step - 1].get('root_pc')
            and parsed[step].get('pitch_classes') == parsed[step - 1].get('pitch_classes')
        )

        # (Kp, Kc, 4)
        diff = curr_v[None, :, :] - prev_v[:, None, :]
        adiff = np.abs(diff).astype(np.float64)

        # 上三声部运动代价：0 半音共同音奖励、1-2 半音级进极低、>4 半音二次方惩罚
        u_abs = adiff[:, :, 1:]  # (Kp, Kc, 3)
        u_cost = np.where(
            u_abs == 0.0,
            -0.30,
            np.where(
                u_abs <= 2.0,
                0.52 * u_abs,
                np.where(
                    u_abs <= 4.0,
                    1.04 + 1.05 * (u_abs - 2.0),
                    3.14 + 1.45 * np.square(u_abs - 4.0),
                ),
            ),
        ).sum(axis=2)

        # 防止前后拍声部越位（Voice Overlap，如新 Tenor 高于旧 Alto）
        overlap_pen = (
            6.5 * (curr_v[None, :, 1] >= prev_v[:, None, 2]).astype(np.float64)
            + 6.5 * (curr_v[None, :, 2] >= prev_v[:, None, 3]).astype(np.float64)
            + 6.5 * (curr_v[None, :, 2] <= prev_v[:, None, 1]).astype(np.float64)
            + 6.5 * (curr_v[None, :, 3] <= prev_v[:, None, 2]).astype(np.float64)
        )

        # 低音连接代价
        db_abs = adiff[:, :, 0]
        if same_chord:
            bass_cost = 0.55 * db_abs
        else:
            bass_cost = 0.14 * np.minimum(db_abs, 12.0) + np.where(db_abs > 8.0, 0.35 * np.square(db_abs - 8.0), 0.0)

        # 平行纯五度 / 纯八度重罚（检查全部 6 对声部）
        par_pen = np.zeros((len(prev_v), len(curr_v)), dtype=np.float64)
        pairs = ((0, 1, 16.0), (0, 2, 16.0), (0, 3, 20.0), (1, 2, 12.0), (2, 3, 12.0), (1, 3, 12.0))
        for v_lo, v_hi, weight in pairs:
            iv_prev = (prev_v[:, v_hi] - prev_v[:, v_lo]) % 12     # (Kp,)
            iv_curr = (curr_v[:, v_hi] - curr_v[:, v_lo]) % 12     # (Kc,)
            is_perf_prev = (iv_prev == 0) | (iv_prev == 7)
            same_iv = iv_prev[:, None] == iv_curr[None, :]
            same_dir = (diff[:, :, v_lo] * diff[:, :, v_hi]) > 0
            par_pen += weight * (is_perf_prev[:, None] & same_iv & same_dir).astype(np.float64)

        # 外声部（Bass 与 Soprano）反向进行奖励
        contrary = ((diff[:, :, 0] * diff[:, :, 3]) < 0).astype(np.float64) * (-0.50)

        trans_mat = dp_costs[-1][:, None] + u_cost + overlap_pen + bass_cost + par_pen + contrary
        best_prev = np.argmin(trans_mat, axis=0)
        best_val = trans_mat[best_prev, np.arange(len(curr_v))] + _state_cost(curr_v, eng)
        dp_costs.append(best_val)
        backptrs.append(best_prev)

    # 回溯最优声部路径
    chosen_indices = [0] * m_steps
    chosen_indices[-1] = int(np.argmin(dp_costs[-1]))
    for step in range(m_steps - 1, 0, -1):
        chosen_indices[step - 1] = int(backptrs[step - 1][chosen_indices[step]])

    out: list[dict] = []
    for step, c in enumerate(parsed):
        v = tuple(int(x) for x in cand_lists[step][chosen_indices[step]])
        row = dict(c)
        row['voicing'] = v
        row['bass'] = v[0]
        row['upper'] = v[1:]
        if step == 0:
            row['upper_motion_st'] = 0.0
        else:
            prev_u = out[-1]['upper']
            row['upper_motion_st'] = round(sum(abs(a - b) for a, b in zip(v[1:], prev_u)) / 3.0, 4)
        out.append(row)
    return out


def voice_leading_metrics(voiced_chords: list[dict]) -> dict:
    """统计已配声部和弦序列的声部连接平滑度、零交叉与平行五八度指标。"""
    if not voiced_chords:
        return {
            'chord_transitions': 0,
            'mean_upper_motion_st': 0.0,
            'max_upper_motion_st': 0.0,
            'voice_crossings': 0,
            'parallel_fifths_octaves': 0,
            'common_tone_ratio': 1.0,
        }

    crossings = 0
    for c in voiced_chords:
        b, t, a, s = c['voicing']
        if not (b < t < a < s):
            crossings += 1

    motions: list[float] = []
    common_kept = 0
    common_total = 0
    parallels = 0

    for prev_c, curr_c in zip(voiced_chords, voiced_chords[1:]):
        vp = prev_c['voicing']
        vc = curr_c['voicing']
        # 仅在真实换和弦时统计声部跳进均值（同和弦延续为 0）
        motions.append(sum(abs(vc[i] - vp[i]) for i in (1, 2, 3)) / 3.0)
        up_prev_pcs = {vp[1] % 12, vp[2] % 12, vp[3] % 12}
        up_curr_pcs = {vc[1] % 12, vc[2] % 12, vc[3] % 12}
        shared = up_prev_pcs & up_curr_pcs
        if shared:
            common_total += len(shared)
            prev_midis = set(vp[1:])
            curr_midis = set(vc[1:])
            common_kept += len(prev_midis & curr_midis)

        for lo_i, hi_i in ((0, 1), (0, 2), (0, 3), (1, 2), (2, 3), (1, 3)):
            iv0 = (vp[hi_i] - vp[lo_i]) % 12
            iv1 = (vc[hi_i] - vc[lo_i]) % 12
            if iv0 in (0, 7) and iv0 == iv1 and (vc[lo_i] - vp[lo_i]) * (vc[hi_i] - vp[hi_i]) > 0:
                parallels += 1

    return {
        'chord_transitions': max(0, len(voiced_chords) - 1),
        'mean_upper_motion_st': round(float(np.mean(motions)) if motions else 0.0, 4),
        'max_upper_motion_st': round(float(np.max(motions)) if motions else 0.0, 4),
        'voice_crossings': int(crossings),
        'parallel_fifths_octaves': int(parallels),
        'common_tone_ratio': round(common_kept / float(max(1, common_total)), 4),
    }


class MotifEngine:
    """单主题核心动机生成与跨段落动机变形引擎（零机械音阶练习、零走音滑音）。"""

    # 精心设计的歌唱性 4–6 音音阶度数轮廓库：(名称, 相对音阶度数偏移元组, 拍长比例元组, 重音权重元组)
    # 任意一条轮廓单调连续步进 <= 2 步，绝不含全八度机械上下行音阶！
    _ARCHETYPES: dict[str, list[tuple[str, tuple[int, ...], tuple[float, ...], tuple[float, ...]]]] = {
        'cinematic_orchestral': [
            ('heroic_leap_resolve', (0, 4, 3, 1, 2), (1.0, 1.5, 0.5, 1.0, 2.0), (0.85, 1.0, 0.72, 0.78, 0.90)),
            ('noble_arch', (0, 2, 4, 2, 3), (1.5, 0.5, 1.0, 1.0, 2.0), (0.88, 0.70, 0.96, 0.76, 0.92)),
            ('horizon_call', (0, 3, 2, 4, 2), (1.0, 1.0, 0.5, 1.5, 2.0), (0.84, 0.92, 0.72, 1.0, 0.88)),
        ],
        'chinese_chamber': [
            ('gong_zhi_lyric', (0, 2, 4, 2, 1, 0), (1.0, 0.5, 1.5, 0.5, 0.5, 2.0), (0.88, 0.74, 1.0, 0.78, 0.72, 0.92)),
            ('jade_leap_turn', (0, 3, 2, 4, 3), (1.0, 1.0, 0.5, 1.5, 2.0), (0.86, 0.94, 0.72, 1.0, 0.90)),
            ('spring_lantern', (2, 4, 2, 0, 1, 2), (0.75, 0.75, 0.5, 1.0, 1.0, 2.0), (0.85, 0.98, 0.75, 0.82, 0.78, 0.92)),
        ],
        'anime_nostalgic': [
            ('sky_yearning', (2, 4, 3, 0, 1, 2), (0.5, 1.5, 1.0, 0.5, 0.5, 2.0), (0.76, 1.0, 0.86, 0.74, 0.78, 0.92)),
            ('summer_memory', (0, 4, 3, 2, 4, 2), (0.5, 1.5, 0.5, 0.5, 1.0, 2.0), (0.74, 1.0, 0.80, 0.76, 0.94, 0.88)),
            ('twilight_waltz', (0, 2, 4, 1, 2), (1.0, 1.0, 1.5, 0.5, 2.0), (0.85, 0.80, 1.0, 0.72, 0.90)),
        ],
        'hitech_minimal': [
            ('crystal_cell', (0, 4, 2, 3), (0.75, 0.75, 1.0, 1.5), (0.92, 0.98, 0.80, 0.88)),
            ('precision_vector', (0, 2, 5, 4, 2), (0.5, 0.5, 1.0, 1.0, 1.0), (0.86, 0.78, 1.0, 0.88, 0.82)),
            ('telemetry_lock', (2, 0, 4, 3), (0.75, 0.75, 1.25, 1.25), (0.88, 0.76, 1.0, 0.90)),
        ],
        'ink_poetic': [
            ('mist_mountain', (0, 3, 2, 0, 2), (1.5, 1.5, 1.0, 1.0, 2.5), (0.84, 0.96, 0.80, 0.74, 0.90)),
            ('bamboo_wind', (2, 4, 2, 1, 0), (1.5, 1.0, 1.5, 1.0, 2.5), (0.86, 0.98, 0.84, 0.74, 0.88)),
            ('river_moon', (0, 2, 4, 2), (1.5, 1.0, 2.0, 2.5), (0.82, 0.78, 1.0, 0.88)),
        ],
        'playful_folk': [
            ('meadow_skip', (0, 2, 4, 1, 2, 0), (0.5, 0.5, 1.0, 0.5, 0.5, 1.0), (0.90, 0.76, 1.0, 0.78, 0.84, 0.92)),
            ('woodland_hop', (0, 3, 1, 4, 2), (0.5, 1.0, 0.5, 1.0, 1.0), (0.88, 0.95, 0.74, 1.0, 0.90)),
            ('sunny_dance', (2, 4, 1, 2, 0), (0.5, 1.0, 0.5, 1.0, 1.0), (0.86, 1.0, 0.76, 0.88, 0.92)),
        ],
    }

    def __init__(self, *, key: str = 'D', scale: str = 'major', style: str = 'cinematic_orchestral', seed: int = 42):
        self.key, self.scale = normalize_key_and_scale(key, scale)
        self.style = style if style in COMPOSER_STYLES else 'cinematic_orchestral'
        self.tonic_pc = NOTE_OFFSETS[self.key.upper()]
        self.scale_iv = SCALES[self.scale]
        self.scale_pcs: frozenset[int] = frozenset((self.tonic_pc + int(iv)) % 12 for iv in self.scale_iv)
        self.seed = int(seed)
        r = rng(self.seed + 101)

        pool = self._ARCHETYPES[self.style]
        choice_idx = int(r.integers(0, len(pool)))
        name, degs, beats, accents = pool[choice_idx]
        self.archetype = name
        self.degrees = tuple(int(d) for d in degs)
        self.beats = tuple(float(b) for b in beats)
        self.accents = tuple(float(a) for a in accents)

        base_midis = [self.scale_degree_to_midi(d, base_octave=4) for d in self.degrees]
        self.intervals = tuple(base_midis[i + 1] - base_midis[i] for i in range(len(base_midis) - 1))

    def scale_degree_to_midi(self, deg_offset: int, base_octave: int = 4) -> int:
        n_iv = len(self.scale_iv)
        oct_shift, idx = divmod(int(deg_offset), n_iv)
        return 12 * (base_octave + 1 + oct_shift) + self.tonic_pc + int(self.scale_iv[idx])

    @staticmethod
    def _chord_at(chords: list[dict], t: float) -> dict:
        for c in chords:
            if c['t0'] - 1e-6 <= t < c['t1'] - 1e-6:
                return c
        return chords[-1]

    def _next_scale_midi(self, midi_pitch: int, direction: int) -> int:
        step = 1 if direction >= 0 else -1
        cand = int(midi_pitch)
        for _ in range(12):
            cand += step
            if (cand % 12) in self.scale_pcs:
                return cand
        return int(midi_pitch)

    def _consonant_adjust(self, midi_pitch: int, chord: dict, strong: bool) -> int:
        """仅当旋律音偏离当前音阶或与和弦骨干音构成尖锐小九度（1 半音上方）碰撞时，吸附至调内协和和弦音。"""
        pcs = tuple(chord.get('pitch_classes') or ())
        pc = int(midi_pitch) % 12
        check_pcs = pcs[:3] if strong else pcs[:2]
        has_harsh_b9 = any(((pc - c_pc) % 12) == 1 for c_pc in check_pcs)
        if pc in self.scale_pcs and (pc in pcs or not has_harsh_b9):
            return int(midi_pitch)
        for delta in (1, -1, 2, -2, 3, -3):
            cand = int(midi_pitch) + delta
            cpc = cand % 12
            if cpc in self.scale_pcs and cpc in pcs:
                return cand
        for delta in (0, 1, -1, 2, -2, 3, -3):
            cand = int(midi_pitch) + delta
            cpc = cand % 12
            if cpc in self.scale_pcs and not any(((cpc - c_pc) % 12) == 1 for c_pc in check_pcs):
                return cand
        for delta in (0, 1, -1, 2, -2, 3, -3):
            cand = int(midi_pitch) + delta
            if (cand % 12) in self.scale_pcs:
                return cand
        return int(midi_pitch)

    def counter_pitch(self, lead_midi: int, chord: dict) -> int:
        """为高潮主旋律音计算严格调内的下对位音（调内下三/四/六度且优先落和弦音，零调外半音如 D 调 Bb/C）。"""
        chord_pcs = tuple(chord.get('pitch_classes') or ())
        chord_set = set(chord_pcs)
        core_pcs = chord_pcs[:3]
        is_pent = _is_pentatonic_family(self.scale)

        best_midi: int | None = None
        best_score = -1e9
        for iv in range(3, 10):
            cand = int(lead_midi) - iv
            pc = cand % 12
            if pc not in self.scale_pcs:
                continue
            if iv == 4:
                s = 6.4
            elif iv == 3:
                s = 6.2
            elif iv == 5:
                s = 5.8 if is_pent else 5.2
            elif iv in (8, 9):
                s = 5.4
            elif iv == 7:
                s = 3.2
            else:
                # iv == 6（三全音）：避免对位声部与主旋律形成增四/减五度刺耳碰撞
                s = -8.0

            if pc in chord_set:
                s += 4.2
                if pc in core_pcs:
                    s += 0.8
            if any(((pc - c_pc) % 12) == 1 for c_pc in core_pcs):
                s -= 7.0

            if s > best_score:
                best_score = s
                best_midi = cand

        if best_midi is not None:
            return best_midi
        return self._next_scale_midi(int(lead_midi) - 2, -1)

    def render_statement(
        self,
        *,
        t_start: float,
        t_limit: float,
        spb: float,
        degree_shift: int,
        base_octave: int,
        time_scale: float,
        vel_base: float,
        chords: list[dict],
        octave_double: bool = False,
        tag: str = 'statement',
    ) -> tuple[list[dict], dict | None]:
        """在 [t_start, t_limit] 内投射一次核心动机（严格保持动机相对度数轮廓与音程方向；空间略紧时自动等比缩拍完整容纳全动机）。"""
        notes_out: list[dict] = []
        statement_midis: list[int] = []
        cur_t = float(t_start)
        avail_span = max(0.0, float(t_limit) - cur_t)
        total_beats = sum(self.beats)
        eff_scale = float(time_scale)
        if total_beats > 0 and avail_span >= 0.48 and (total_beats * eff_scale * spb) > 0.90 * avail_span:
            eff_scale = max(0.28, (0.88 * avail_span) / (total_beats * spb))

        for idx, (d_rel, b_dur, acc) in enumerate(zip(self.degrees, self.beats, self.accents)):
            if cur_t >= t_limit - 0.04:
                break
            dur_s = min(t_limit - cur_t, max(0.08, b_dur * eff_scale * spb))
            if dur_s < 0.05:
                break
            raw_midi = self.scale_degree_to_midi(d_rel + degree_shift, base_octave=base_octave)
            active_c = self._chord_at(chords, cur_t)
            # 仅对首尾骨干音做小二度防撞修正，中间音严格遵循调内音阶以 100% 锁定动机轮廓相关性
            is_anchor = (idx == 0 or idx == len(self.degrees) - 1)
            pitch = self._consonant_adjust(raw_midi, active_c, strong=is_anchor)
            # 确保与上一音方向跟原动机完全一致（防止半音吸附翻转轮廓正负号）
            if idx > 0 and len(statement_midis) == idx:
                orig_step = self.degrees[idx] - self.degrees[idx - 1]
                actual_step = pitch - statement_midis[-1]
                if orig_step > 0 and actual_step <= 0:
                    pitch = raw_midi if raw_midi > statement_midis[-1] else self._next_scale_midi(statement_midis[-1], 1)
                elif orig_step < 0 and actual_step >= 0:
                    pitch = raw_midi if raw_midi < statement_midis[-1] else self._next_scale_midi(statement_midis[-1], -1)
                elif orig_step == 0:
                    pitch = statement_midis[-1]

            vel = float(np.clip(vel_base * acc, 0.22, 0.98))
            notes_out.append({
                't0': round(cur_t, 6),
                't1': round(cur_t + dur_s * 0.94, 6),
                'midi': int(pitch),
                'vel': round(vel, 4),
                'role': 'motif_lead',
                'transform': tag,
            })
            if octave_double and pitch + 12 <= 88:
                notes_out.append({
                    't0': round(cur_t, 6),
                    't1': round(cur_t + dur_s * 0.94, 6),
                    'midi': int(pitch - 12 if pitch >= 72 else pitch + 12),
                    'vel': round(vel * 0.84, 4),
                    'role': 'motif_octave',
                    'transform': tag,
                })
            statement_midis.append(int(pitch))
            cur_t += b_dur * eff_scale * spb

        if len(statement_midis) < 3:
            return notes_out, None
        ivs = tuple(statement_midis[i + 1] - statement_midis[i] for i in range(len(statement_midis) - 1))
        meta = {
            't0': round(float(t_start), 4),
            't1': round(float(cur_t), 4),
            'transform': tag,
            'degree_shift': int(degree_shift),
            'midis': tuple(statement_midis),
            'intervals': ivs,
        }
        return notes_out, meta


def _normalize_sections(raw_secs: list[dict], eff_dur: float) -> list[dict]:
    if not raw_secs:
        if eff_dur >= 4.0:
            raw_secs = [
                {'id': 'S1_intro', 't0': 0.0, 't1': 0.28 * eff_dur, 'energy': 0.35, 'mood': 'establishing'},
                {'id': 'S1_dev', 't0': 0.28 * eff_dur, 't1': 0.60 * eff_dur, 'energy': 0.58, 'mood': 'development'},
                {'id': 'S1_breath', 't0': 0.60 * eff_dur, 't1': 0.72 * eff_dur, 'energy': 0.42, 'mood': 'suspension'},
                {'id': 'S1_finale', 't0': 0.72 * eff_dur, 't1': eff_dur, 'energy': 0.92, 'mood': 'climax'},
            ]
        else:
            raw_secs = [
                {'id': 'S1_intro', 't0': 0.0, 't1': 0.45 * eff_dur, 'energy': 0.35, 'mood': 'establishing'},
                {'id': 'S2_finale', 't0': 0.45 * eff_dur, 't1': eff_dur, 'energy': 0.92, 'mood': 'climax'},
            ]

    secs: list[dict] = []
    for idx, s in enumerate(raw_secs):
        t0 = float(s.get('t0', 0.0 if idx == 0 else secs[-1]['t1']))
        t1 = float(s.get('t1', eff_dur))
        t0 = max(0.0, min(eff_dur, t0))
        t1 = max(t0, min(eff_dur, t1))
        if t1 <= t0 + 1e-6:
            continue
        raw_mood = str(s.get('mood') or 'development').strip().lower()
        mood = 'suspension' if raw_mood in ('suspension', 'silence', 'breath') else raw_mood
        secs.append({
            'id': str(s.get('id') or f'sec_{idx + 1}'),
            't0': t0,
            't1': t1,
            'energy': float(np.clip(s.get('energy', 0.42 if mood == 'suspension' else 0.56), 0.12, 1.0)),
            'mood': mood,
            'chord_deg': list(s.get('chord_deg') or []),
        })
    if not secs:
        secs = [{'id': 'S1', 't0': 0.0, 't1': eff_dur, 'energy': 0.65, 'mood': 'development', 'chord_deg': []}]
    secs[0]['t0'] = 0.0
    for i in range(len(secs) - 1):
        secs[i]['t1'] = secs[i + 1]['t0']
    secs[-1]['t1'] = eff_dur
    return secs


def _extract_event_times(events: list | None, fps: int, dur: float) -> list[float]:
    if not events:
        return []
    times: list[float] = []
    for ev in events:
        if isinstance(ev, (int, float)) and not isinstance(ev, bool):
            t = float(ev)
        elif isinstance(ev, dict):
            if isinstance(ev.get('t'), (int, float)):
                t = float(ev['t'])
            elif isinstance(ev.get('frame'), int):
                t = ev['frame'] / float(max(1, fps))
            else:
                continue
        else:
            continue
        if 0.0 <= t < dur:
            times.append(round(t, 6))
    return sorted(dict.fromkeys(times))


def compose_film_score(
    spec_or_sections,
    *,
    dur: float | None = None,
    fps: int = 24,
    key: str = 'D',
    scale: str = 'major',
    bpm: float = 96.0,
    style: str | None = None,
    prompt: str = '',
    world: str | None = None,
    events: list | None = None,
    seed: int = 42,
) -> dict:
    """编排完整的多声部电影配乐总谱（和声连接 + 单一动机变形 + 挂留呼吸 + 弱起引子 + 终章扩充）。"""
    if isinstance(spec_or_sections, dict):
        plan = spec_or_sections
    elif isinstance(spec_or_sections, (list, tuple)):
        plan = {'sections': list(spec_or_sections)}
    else:
        raise ValueError(f'compose_film_score 需要 dict 或分段列表，收到 {type(spec_or_sections).__name__}')

    eff_fps = int(plan.get('fps', fps) if fps == 24 and 'fps' in plan else fps)
    eff_key_in = plan.get('key', key) if key == 'D' and 'key' in plan else key
    eff_scale_in = plan.get('scale', scale) if scale == 'major' and 'scale' in plan else scale
    eff_bpm = float(plan.get('bpm', bpm) if bpm == 96.0 and 'bpm' in plan else bpm)
    norm_key, norm_scale = normalize_key_and_scale(eff_key_in, eff_scale_in)

    raw_secs = list(plan.get('sections') or [])
    eff_dur = float(dur if dur is not None else (plan.get('dur') or (max(float(s['t1']) for s in raw_secs) if raw_secs else 8.0)))
    if eff_dur <= 0.0:
        raise ValueError(f'总谱时长必须为正数，收到 {eff_dur!r}')

    eff_style = (
        style if (style and style in COMPOSER_STYLES)
        else (plan.get('style') if plan.get('style') in COMPOSER_STYLES else infer_composer_style(prompt or str(plan.get('prompt') or ''), world=world or plan.get('world'), scale=norm_scale))
    )

    secs = _normalize_sections(raw_secs, eff_dur)
    raw_chords = plan_harmonic_arc(secs, key=norm_key, scale=norm_scale, style=eff_style, bpm=eff_bpm, dur=eff_dur)
    voiced_chords = solve_voice_leading(raw_chords)
    vl_stats = voice_leading_metrics(voiced_chords)

    # 回填推导出的每个分段真实和弦音级表
    for sec in secs:
        sec_degs = [c['degree'] for c in voiced_chords if abs(c['t0'] - sec['t0']) < 1e-5 or (sec['t0'] <= c['t0'] < sec['t1'] - 1e-5)]
        if sec_degs:
            sec['chord_deg'] = sec_degs
        elif not sec['chord_deg']:
            sec['chord_deg'] = [1, 5]

    motif_eng = MotifEngine(key=norm_key, scale=norm_scale, style=eff_style, seed=int(seed))
    ev_times = _extract_event_times(events if events is not None else plan.get('events'), eff_fps, eff_dur)
    spb = 60.0 / max(20.0, eff_bpm)
    tonic_pc = NOTE_OFFSETS[norm_key.upper()]

    harmony_notes: list[dict] = []
    bass_notes: list[dict] = []
    melody_notes: list[dict] = []
    arp_notes: list[dict] = []
    perc_notes: list[dict] = []
    motif_statements: list[dict] = []
    pickup_events: list[dict] = []

    # 1) 和声声部与低音声部（严格遵循 DP 最优四声部连接；呼吸段转为高音清透泛音属持续音 Fermata Breath！）
    for s_idx, sec in enumerate(secs):
        s_t0, s_t1 = sec['t0'], sec['t1']
        s_dur = s_t1 - s_t0
        mood = sec['mood']
        eng = sec['energy']
        next_sec = secs[s_idx + 1] if s_idx + 1 < len(secs) else None
        sec_chords = [c for c in voiced_chords if s_t0 - 1e-5 <= c['t0'] < s_t1 - 1e-5]

        if mood == 'suspension':
            # Fermata Breath：静音打击乐与低频厚重铺底，仅保留 V7sus4 高把位晶莹泛音持续音（根音 + 五音 + 挂四/九音）
            dom_pc = (tonic_pc + 7) % 12
            sus_root = 60 + dom_pc if (60 + dom_pc) <= 69 else 48 + dom_pc
            sus_fifth = sus_root + 7
            sus_color = sus_root + 5  # sus4 (= 主音高八度共同音预备！)
            for p_midi, v_mul in ((sus_root, 0.30), (sus_fifth, 0.26), (sus_color, 0.24)):
                harmony_notes.append({
                    't0': round(s_t0, 6),
                    't1': round(s_t1, 6),
                    'midi': int(p_midi),
                    'vel': round(v_mul, 4),
                    'role': 'fermata_breath_pedal',
                    'section_id': sec['id'],
                })

            # 若下一段进入高能量段（climax / rising），在末尾 0.28–0.42s 注入弱起引子（Anacrusis Pickup）
            if next_sec and next_sec['energy'] >= eng + 0.12 and s_dur >= 0.42:
                pk_dur = float(np.clip(0.36 * s_dur, 0.28, 0.42))
                pk_t0 = max(s_t0 + 0.08, s_t1 - pk_dur)
                actual_pk = s_t1 - pk_t0
                n_gliss = 6 if actual_pk >= 0.32 else 5
                # 上行五声/调内刮奏直指高潮首拍主音（Tonic）
                for g_i in range(n_gliss):
                    gt = pk_t0 + g_i * (0.86 * actual_pk / n_gliss)
                    deg_step = g_i - n_gliss
                    g_midi = motif_eng.scale_degree_to_midi(deg_step, base_octave=5)
                    g_vel = round(0.32 + 0.10 * g_i, 4)
                    arp_notes.append({
                        't0': round(gt, 6),
                        't1': round(min(eff_dur, gt + 0.42), 6),
                        'midi': int(g_midi),
                        'vel': g_vel,
                        'role': 'anacrusis_gliss',
                        'section_id': sec['id'],
                    })
                # 轻柔定音鼓/堂鼓渐强滚奏（pp -> mf），严格落在 s_t1 高潮正拍解决
                n_roll = 5
                for r_i in range(n_roll):
                    rt = pk_t0 + r_i * (0.90 * actual_pk / n_roll)
                    perc_notes.append({
                        't0': round(rt, 6),
                        't1': round(min(eff_dur, rt + 0.24), 6),
                        'midi': int(36 + dom_pc),
                        'vel': round(0.18 + 0.11 * r_i, 4),
                        'role': 'anacrusis_roll',
                        'section_id': sec['id'],
                    })
                pickup_events.append({
                    'section_id': sec['id'],
                    't0': round(pk_t0, 6),
                    't1': round(s_t1, 6),
                    'target_section': next_sec['id'],
                })
            sec['transform'] = 'fermata_breath'
            continue

        # 非呼吸段的四声部和声与低音铺底
        for c in sec_chords:
            b_m, t_m, a_m, s_m = c['voicing']
            c_vel = float(np.clip(0.38 + 0.52 * eng, 0.28, 0.94))
            bass_notes.append({
                't0': c['t0'],
                't1': c['t1'],
                'midi': int(b_m),
                'vel': round(min(0.96, c_vel * 1.04), 4),
                'role': 'bass_foundation',
                'section_id': sec['id'],
            })
            for v_idx, u_m in enumerate((t_m, a_m, s_m)):
                harmony_notes.append({
                    't0': c['t0'],
                    't1': c['t1'],
                    'midi': int(u_m),
                    'vel': round(c_vel * (0.86 if v_idx < 2 else 0.92), 4),
                    'role': f'harmony_v{v_idx + 1}',
                    'section_id': sec['id'],
                })
            # 高潮段叠加温暖高八度弦乐合奏厚度
            if eng >= 0.78 and s_m + 12 <= 84:
                harmony_notes.append({
                    't0': c['t0'],
                    't1': c['t1'],
                    'midi': int(s_m + 12),
                    'vel': round(c_vel * 0.68, 4),
                    'role': 'harmony_high_strings',
                    'section_id': sec['id'],
                })

            # 锁拍分解和弦琶音（严格取自当前 DP 声部音高，绝无机械音阶乱跑）
            subdiv = 4 if eng >= 0.78 else (2 if eng >= 0.48 else 1)
            step_s = spb / float(subdiv)
            arp_pattern = (
                [t_m, a_m, s_m, t_m + 12, s_m, a_m, t_m + 12, s_m + 12]
                if eng >= 0.78
                else ([t_m, a_m, s_m, a_m] if subdiv >= 2 else [t_m, s_m])
            )
            first_st = int(math.ceil((c['t0'] - 1e-6) / step_s))
            last_st = int(math.floor((c['t1'] - 1e-6) / step_s))
            # 片尾最后 1.4s 终止主和弦放缓琶音密度，让主和弦余韵从容舒展
            is_final_ring = (c.get('cadence') == 'final_resolution' and eff_dur >= 6.0)
            for st_k in range(first_st, last_st + 1):
                bt = st_k * step_s
                if bt < c['t0'] - 1e-6 or bt >= c['t1'] - 1e-6:
                    continue
                if is_final_ring and (bt - c['t0']) > 0.65 and (st_k % subdiv != 0):
                    continue
                p_arp = arp_pattern[st_k % len(arp_pattern)]
                accent = 1.12 if (st_k % subdiv == 0) else 0.78
                arp_vel = float(np.clip((0.30 + 0.50 * eng) * accent, 0.20, 0.92))
                ring_s = min(eff_dur - bt, step_s * (2.6 if is_final_ring else 1.85))
                if ring_s > 0.04:
                    arp_notes.append({
                        't0': round(bt, 6),
                        't1': round(bt + ring_s, 6),
                        'midi': int(p_arp),
                        'vel': round(arp_vel, 4),
                        'role': 'chord_arpeggio',
                        'section_id': sec['id'],
                    })

        # 2) 单一核心动机的分段变形发展（Motivic Development）
        phrase_beats = sum(motif_eng.beats)
        if mood == 'establishing':
            sec['transform'] = 'lyrical_statement'
            m_notes, m_meta = motif_eng.render_statement(
                t_start=s_t0 + min(0.12, 0.08 * s_dur),
                t_limit=s_t1,
                spb=spb,
                degree_shift=0,
                base_octave=4,
                time_scale=1.0,
                vel_base=0.58,
                chords=voiced_chords,
                octave_double=False,
                tag='establishing_statement',
            )
            melody_notes.extend(m_notes)
            if m_meta:
                m_meta['section_id'] = sec['id']
                motif_statements.append(m_meta)

        elif mood == 'development':
            sec['transform'] = 'diminution_variation'
            # 节奏紧缩变奏（0.72x 紧凑推进）+ 若段落够长跟一句属调呼应变形
            m_notes, m_meta = motif_eng.render_statement(
                t_start=s_t0 + 0.04,
                t_limit=s_t1,
                spb=spb,
                degree_shift=0,
                base_octave=4,
                time_scale=0.72,
                vel_base=0.70,
                chords=voiced_chords,
                octave_double=False,
                tag='development_diminution',
            )
            melody_notes.extend(m_notes)
            if m_meta:
                m_meta['section_id'] = sec['id']
                motif_statements.append(m_meta)
                second_t = m_meta['t1'] + 0.25 * spb
                if s_t1 - second_t >= 0.85:
                    m2_notes, m2_meta = motif_eng.render_statement(
                        t_start=second_t,
                        t_limit=s_t1,
                        spb=spb,
                        degree_shift=2,
                        base_octave=4,
                        time_scale=0.72,
                        vel_base=0.74,
                        chords=voiced_chords,
                        octave_double=False,
                        tag='development_answer',
                    )
                    melody_notes.extend(m2_notes)
                    if m2_meta:
                        m2_meta['section_id'] = sec['id']
                        motif_statements.append(m2_meta)

            # 画面事件锁拍和声点缀音（锁在当前和弦高音协和音级上）
            for ev_t in ev_times:
                if s_t0 <= ev_t < s_t1 - 0.08:
                    c_ev = MotifEngine._chord_at(voiced_chords, ev_t)
                    arp_notes.append({
                        't0': round(ev_t, 6),
                        't1': round(min(s_t1, ev_t + 0.32), 6),
                        'midi': int(c_ev['voicing'][3] + 12 if c_ev['voicing'][3] + 12 <= 84 else c_ev['voicing'][3]),
                        'vel': 0.72,
                        'role': 'event_ornament',
                        'section_id': sec['id'],
                    })

        elif mood == 'rising':
            sec['transform'] = 'diatonic_sequence'
            # 严格调内模进（+1 -> +2 -> +4 度逐句攀升，绝无半音移调跑调）
            seq_shifts = (1, 2, 4)
            cur_p = s_t0 + 0.02
            step_scale = 0.68 if s_dur < 2.2 * phrase_beats * spb else 0.80
            for sh_idx, deg_sh in enumerate(seq_shifts):
                if s_t1 - cur_p < 0.70:
                    break
                mn, mm = motif_eng.render_statement(
                    t_start=cur_p,
                    t_limit=s_t1,
                    spb=spb,
                    degree_shift=deg_sh,
                    base_octave=4,
                    time_scale=step_scale,
                    vel_base=0.74 + 0.06 * sh_idx,
                    chords=voiced_chords,
                    octave_double=(sh_idx >= 1),
                    tag=f'rising_sequence_+{deg_sh}',
                )
                melody_notes.extend(mn)
                if mm:
                    mm['section_id'] = sec['id']
                    motif_statements.append(mm)
                    cur_p = mm['t1'] + 0.15 * spb
                else:
                    break

        else:
            # climax：八度辉煌扩充主旋律 + 协和六度/三度副旋律对位 + 定音鼓/堂鼓与调性锣绽放
            sec['transform'] = 'octave_augmentation_counter'
            climax_limit = (s_t1 - 1.15) if (s_idx == len(secs) - 1 and eff_dur >= 6.0 and s_dur >= 2.8) else s_t1
            mn, mm = motif_eng.render_statement(
                t_start=s_t0,
                t_limit=max(s_t0 + 0.85, climax_limit),
                spb=spb,
                degree_shift=0,
                base_octave=5,
                time_scale=1.0,
                vel_base=0.94,
                chords=voiced_chords,
                octave_double=True,
                tag='climax_octave_statement',
            )
            melody_notes.extend(mn)
            if mm:
                mm['section_id'] = sec['id']
                motif_statements.append(mm)
                # 协和调内下三度/四度/六度副歌对位应答（100% 锁定当前音阶与和弦音，绝无 Bb/C 等调外半音）
                for n_lead in [x for x in mn if x['role'] == 'motif_lead']:
                    c_here = MotifEngine._chord_at(voiced_chords, n_lead['t0'])
                    cnt_pitch = motif_eng.counter_pitch(n_lead['midi'], c_here)
                    melody_notes.append({
                        't0': n_lead['t0'],
                        't1': n_lead['t1'],
                        'midi': int(cnt_pitch),
                        'vel': round(n_lead['vel'] * 0.68, 4),
                        'role': 'counter_melody',
                        'transform': 'climax_counter',
                    })

            # 若有终章解决段（final_resolution），在终止式落点叠上温暖圆满的主音八度收官长音
            fin_chords = [c for c in sec_chords if c.get('cadence') == 'final_resolution']
            if fin_chords and eff_dur >= 6.0:
                fc = fin_chords[-1]
                if fc['t0'] >= s_t0 + 0.6:
                    tonic_hi = motif_eng.scale_degree_to_midi(0, base_octave=5)
                    melody_notes.append({
                        't0': fc['t0'],
                        't1': round(min(s_t1, fc['t1']), 6),
                        'midi': int(tonic_hi),
                        'vel': 0.88,
                        'role': 'final_tonic_hold',
                        'transform': 'final_cadence_hold',
                    })

            # 高潮首拍凯旋重音（定音鼓/堂鼓 + 调性暖锣辉光）与正拍节拍锚点
            perc_notes.append({
                't0': round(s_t0, 6),
                't1': round(min(eff_dur, s_t0 + 1.45), 6),
                'midi': int(36 + tonic_pc),
                'vel': 0.92,
                'role': 'climax_downbeat_gong',
                'section_id': sec['id'],
            })
            beat_k0 = int(math.ceil((s_t0 - 1e-6) / spb))
            beat_k1 = int(math.floor((s_t1 - 1e-6) / spb))
            for bk in range(beat_k0, beat_k1 + 1):
                bt = bk * spb
                if bt < s_t0 - 1e-6 or bt >= s_t1 - 0.35:
                    continue
                if fin_chords and bt > fin_chords[-1]['t0'] + 0.05:
                    # 终章最终主和弦落定后停止密集鼓点，让主和弦纯净余韵回荡
                    continue
                if (bk - beat_k0) % 2 == 0:
                    c_bt = MotifEngine._chord_at(voiced_chords, bt)
                    perc_notes.append({
                        't0': round(bt, 6),
                        't1': round(min(eff_dur, bt + 0.55), 6),
                        'midi': int(c_bt['bass']),
                        'vel': 0.84 if bk == beat_k0 else 0.68,
                        'role': 'climax_timpani',
                        'section_id': sec['id'],
                    })

        # 非呼吸前段切入下一高能段（若中间未设显式 suspension 段）也补一个温和切镜前刮奏引子
        if next_sec and next_sec['mood'] != 'suspension' and (next_sec['energy'] - eng) >= 0.18 and s_dur >= 0.65:
            pk_len = min(0.36, 0.35 * s_dur)
            pk_a = s_t1 - pk_len
            for gi in range(4):
                gt = pk_a + gi * (0.85 * pk_len / 4.0)
                gm = motif_eng.scale_degree_to_midi(gi - 4, base_octave=5)
                arp_notes.append({
                    't0': round(gt, 6),
                    't1': round(min(eff_dur, gt + 0.38), 6),
                    'midi': int(gm),
                    'vel': round(0.36 + 0.09 * gi, 4),
                    'role': 'transition_gliss',
                    'section_id': sec['id'],
                })

    active_onsets = sorted({
        round(n['t0'], 6)
        for tr in (melody_notes, arp_notes, perc_notes)
        for n in tr
        if n.get('role') not in ('anacrusis_gliss', 'anacrusis_roll')
    })

    return {
        'schema': 'beiming.composer-score/1',
        'dur': eff_dur,
        'fps': eff_fps,
        'key': norm_key,
        'scale': norm_scale,
        'bpm': eff_bpm,
        'style': eff_style,
        'seed': int(seed),
        'motif': {
            'archetype': motif_eng.archetype,
            'degrees': motif_eng.degrees,
            'intervals': motif_eng.intervals,
            'beats': motif_eng.beats,
            'statements': motif_statements,
        },
        'sections': secs,
        'chords': voiced_chords,
        'voice_leading': vl_stats,
        'pickups': pickup_events,
        'tracks': {
            'harmony': harmony_notes,
            'bass': bass_notes,
            'melody': melody_notes,
            'arpeggio': arp_notes,
            'percussion': perc_notes,
        },
        'note_onsets': active_onsets,
    }


# ───────────────────────── 100% 标准音高（0.0 cents）声学导引合成器 ─────────────────────────

def _place_mono_or_stereo(buf: np.ndarray, sig: np.ndarray, start_idx: int, gain: float = 1.0, pan: float = 0.0) -> None:
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
        gl, gr = pan_lr(float(np.clip(pan, -0.55, 0.55)))
        buf[s0:e0, 0] += seg * (gain * gl)
        buf[s0:e0, 1] += seg * (gain * gr)
    else:
        buf[s0:e0] += seg * gain


def _synth_sustained_instrument(
    freq_hz: float,
    dur_s: float,
    sr: int,
    r: np.random.Generator,
    *,
    timbre: str = 'strings',
    vel: float = 0.7,
) -> np.ndarray:
    """合成严格零跑调（精确整数倍频 k*f0，零非对称微失谐）的弦乐/大提琴/笙/竹笛/洞箫/泛音持续单音。"""
    n = max(16, int(round(dur_s * sr)))
    if freq_hz <= 20.0 or freq_hz >= 0.44 * sr:
        return np.zeros(n, dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / float(sr)

    if timbre == 'flageolet':
        # 悬停呼吸专用清透泛音（Fermata Breath）：纯基频 + 轻柔八度泛音，温润呼吸包络（绝不断档为 0）
        atk = smoothstep(0.0, min(0.12, 0.22 * dur_s), t)
        rel = 1.0 - smoothstep(max(0.0, dur_s - min(0.14, 0.24 * dur_s)), dur_s, t)
        breath_sw = 0.94 + 0.06 * np.sin(2.0 * math.pi * 0.85 * t)
        y = np.sin(2.0 * math.pi * freq_hz * t)
        if 2.0 * freq_hz < 0.42 * sr:
            y += 0.22 * np.sin(2.0 * math.pi * (2.0 * freq_hz) * t + 0.4)
        return y * atk * rel * breath_sw * (0.48 * vel)

    # 延迟对称零均值微颤音（仅用于中高音歌唱旋律，低音与极简垫底严格 0 颤音）
    use_vib = timbre in ('strings', 'horn_strings', 'dizi', 'xiao', 'flute') and dur_s >= 0.32 and freq_hz >= 190.0
    if use_vib:
        vib_depth = 0.0022 if timbre in ('dizi', 'strings', 'horn_strings') else 0.0014
        vib_gate = smoothstep(0.10, min(0.32, 0.65 * dur_s), t)
        # 严格零均值正弦调制相位（积分有界且周期对称，平均频率误差 0.00 cents！）
        phase_vib = (vib_depth * freq_hz / (5.2)) * vib_gate * (1.0 - np.cos(2.0 * math.pi * 5.2 * t))
    else:
        phase_vib = 0.0

    if timbre == 'dizi':
        weights = (1.0, 0.46, 0.34, 0.16, 0.08, 0.03)
        atk_t, rel_t, cutoff = 0.028, 0.085, 5200.0
    elif timbre in ('xiao', 'flute'):
        weights = (1.0, 0.28, 0.10, 0.03)
        atk_t, rel_t, cutoff = 0.045, 0.110, 3400.0
    elif timbre == 'sheng':
        weights = (1.0, 0.38, 0.52, 0.18, 0.22, 0.07)
        atk_t, rel_t, cutoff = 0.055, 0.120, 3200.0
    elif timbre == 'glass_pad':
        weights = (1.0, 0.35, 0.12, 0.05)
        atk_t, rel_t, cutoff = 0.065, 0.140, 2800.0
    elif timbre == 'cello':
        weights = (1.0, 0.68, 0.48, 0.28, 0.16, 0.09, 0.05)
        atk_t, rel_t, cutoff = 0.055, 0.120, 1900.0 + 900.0 * vel
    else:
        # strings / horn_strings
        weights = (1.0, 0.62, 0.46, 0.30, 0.19, 0.12, 0.07, 0.04)
        atk_t, rel_t, cutoff = 0.048, 0.110, 1600.0 + 2800.0 * vel

    y = np.zeros(n, dtype=np.float64)
    for k_idx, w_k in enumerate(weights, start=1):
        fk = freq_hz * k_idx
        if fk >= 0.43 * sr:
            break
        ph0 = float(r.uniform(0.0, 2.0 * math.pi))
        dyn_scale = (vel ** (1.0 + 0.14 * (k_idx - 1)))
        if use_vib:
            y += w_k * dyn_scale * np.sin(2.0 * math.pi * (fk * t + k_idx * phase_vib) + ph0)
        else:
            y += w_k * dyn_scale * np.sin(2.0 * math.pi * fk * t + ph0)

    atk = smoothstep(0.0, min(atk_t, 0.38 * dur_s), t)
    rel = 1.0 - smoothstep(max(0.0, dur_s - min(rel_t, 0.42 * dur_s)), dur_s, t)
    arch = 0.88 + 0.16 * np.sin(math.pi * np.clip(t / max(dur_s, 1e-4), 0.0, 1.0))
    y = y * atk * rel * arch
    sos = butter(2, min(0.42 * sr, cutoff), 'low', fs=float(sr), output='sos')
    return sosfilt(sos, y) * 0.26


def _synth_plucked_or_struck(
    freq_hz: float,
    dur_s: float,
    sr: int,
    r: np.random.Generator,
    *,
    timbre: str = 'harp',
    vel: float = 0.75,
) -> np.ndarray:
    """合成竖琴 / 古筝 / 琵琶 / 古琴 / 毡音钢琴 / 马林巴 / 大提琴拨奏音粒（100% 准音，零毛刺噪声）。"""
    n = max(16, int(round(dur_s * sr)))
    if freq_hz <= 22.0 or freq_hz >= 0.44 * sr:
        return np.zeros(n, dtype=np.float64)
    t = np.arange(n, dtype=np.float64) / float(sr)
    atk = smoothstep(0.0, min(0.0024 if timbre in ('pipa', 'guzheng', 'marimba') else 0.0038, 0.15 * dur_s), t)
    rel = 1.0 - smoothstep(max(0.0, dur_s - min(0.035, 0.25 * dur_s)), dur_s, t)
    y = np.zeros(n, dtype=np.float64)

    if timbre == 'marimba':
        # 玫瑰木琴键：基频圆润饱满 + 4x 泛音快速阻尼衰减
        tau0 = max(0.08, min(0.55, 0.65 * dur_s))
        for ratio, amp, dm in ((1.0, 1.0, 1.0), (2.0, 0.12, 0.45), (4.0, 0.28 * vel, 0.16)):
            fk = freq_hz * ratio
            if fk < 0.43 * sr:
                y += amp * np.exp(-t / (tau0 * dm)) * np.sin(2.0 * math.pi * fk * t)
        return y * atk * rel * (0.40 * vel)

    if timbre == 'pizz_bass':
        tau0 = max(0.10, min(0.48, 0.60 * dur_s))
        for k, amp in ((1, 1.0), (2, 0.48), (3, 0.20), (4, 0.08)):
            fk = freq_hz * k
            if fk < 0.42 * sr:
                y += amp * np.exp(-t / (tau0 / (1.0 + 0.65 * (k - 1)))) * np.sin(2.0 * math.pi * fk * t)
        return y * atk * rel * (0.44 * vel)

    if timbre == 'felt_piano':
        tau0 = max(0.22, min(1.80, 0.95 * dur_s))
        harm_amps = (1.0, 0.56, 0.30, 0.15, 0.07, 0.03)
        decay_slope = 0.48
        gain_mul = 0.34
    elif timbre == 'guzheng':
        tau0 = max(0.18, min(1.55, 0.88 * dur_s))
        harm_amps = (1.0, 0.68, 0.45, 0.28, 0.16, 0.09, 0.05)
        decay_slope = 0.55
        gain_mul = 0.33
    elif timbre == 'pipa':
        tau0 = max(0.11, min(0.75, 0.68 * dur_s))
        harm_amps = (0.88, 1.0, 0.62, 0.38, 0.22, 0.12, 0.06)
        decay_slope = 0.72
        gain_mul = 0.32
    elif timbre == 'guqin':
        tau0 = max(0.25, min(1.90, 0.95 * dur_s))
        harm_amps = (1.0, 0.52, 0.26, 0.11, 0.04)
        decay_slope = 0.62
        gain_mul = 0.34
    else:
        # concert harp
        tau0 = max(0.16, min(1.45, 0.82 * dur_s))
        harm_amps = (1.0, 0.54, 0.32, 0.18, 0.09, 0.04)
        decay_slope = 0.58
        gain_mul = 0.34

    for k_idx, h_amp in enumerate(harm_amps, start=1):
        fk = freq_hz * k_idx
        if fk >= 0.43 * sr:
            break
        tau_k = tau0 / (1.0 + decay_slope * (k_idx - 1))
        v_scale = vel ** (1.0 + 0.16 * (k_idx - 1))
        ph = float(r.uniform(0.0, 0.30))
        y += h_amp * v_scale * np.exp(-t / tau_k) * np.sin(2.0 * math.pi * fk * t + ph)

    return y * atk * rel * gain_mul


def _synth_percussion_note(
    freq_hz: float,
    dur_s: float,
    sr: int,
    r: np.random.Generator,
    *,
    role: str = 'climax_timpani',
    vel: float = 0.8,
) -> np.ndarray:
    """合成调性定音鼓/堂鼓重音、弱起滚奏与高潮首拍暖锣辉光（无刺耳高频白噪）。"""
    n = max(16, int(round(dur_s * sr)))
    t = np.arange(n, dtype=np.float64) / float(sr)
    atk = smoothstep(0.0, min(0.0045, 0.18 * dur_s), t)
    rel = 1.0 - smoothstep(max(0.0, dur_s - min(0.06, 0.30 * dur_s)), dur_s, t)

    base_f = float(np.clip(freq_hz, 55.0, 165.0))
    if role == 'climax_downbeat_gong':
        # 温暖调性铜锣绽放 + 定音鼓根音基座
        y = (
            0.78 * np.exp(-t / 0.52) * np.sin(2.0 * math.pi * base_f * t)
            + 0.36 * np.exp(-t / 0.85) * np.sin(2.0 * math.pi * (base_f * 2.0) * t + 0.3)
            + 0.22 * np.exp(-t / 0.95) * np.sin(2.0 * math.pi * (base_f * 3.0) * t + 0.7)
            + 0.12 * np.exp(-t / 0.65) * np.sin(2.0 * math.pi * (base_f * 4.0) * t + 1.1)
        )
        return y * atk * rel * (0.42 * vel)

    tau = 0.16 if role == 'anacrusis_roll' else 0.34
    y = (
        1.0 * np.exp(-t / tau) * np.sin(2.0 * math.pi * base_f * t)
        + 0.42 * np.exp(-t / (0.55 * tau)) * np.sin(2.0 * math.pi * (1.50 * base_f) * t + 0.2)
        + 0.18 * np.exp(-t / (0.32 * tau)) * np.sin(2.0 * math.pi * (2.0 * base_f) * t + 0.5)
    )
    thump_noise = sosfilt(butter(2, [90.0, 320.0], 'band', fs=float(sr), output='sos'), r.standard_normal(n))
    y += 0.08 * vel * np.exp(-t / 0.018) * thump_noise
    return y * atk * rel * (0.38 * vel)


def render_score_wav(
    score: dict,
    *,
    sr: int = 48000,
    pad_tail_s: float = 0.0,
    peak_dbfs: float = -3.0,
    seed: int | None = None,
) -> np.ndarray:
    """将 compose_film_score 生成的总谱确定性合成为立体声波形（100% A4=440Hz，支持 pad_tail_s 延续主和弦余韵）。"""
    sr_out = int(sr)
    if sr_out < 8000:
        raise ValueError(f'采样率 sr 过低：{sr_out}')
    base_dur = float(score['dur'])
    tail_s = max(0.0, float(pad_tail_s))
    total_dur = base_dur + tail_s

    synth_sr = SR
    n_synth = max(2, int(round(total_dur * synth_sr)))
    eff_seed = int(score.get('seed', 42) if seed is None else seed)
    r = rng(eff_seed + 303)

    style = score.get('style') or 'cinematic_orchestral'
    orch = _STYLE_ORCHESTRATION.get(style, _STYLE_ORCHESTRATION['cinematic_orchestral'])
    tracks = score['tracks']
    secs = score['sections']

    mix_bus = np.zeros((n_synth, 2), dtype=np.float64)
    breath_bus = np.zeros((n_synth, 2), dtype=np.float64)

    def _sec_gain_at(t_sec: float) -> float:
        for s in secs:
            if s['t0'] - 1e-5 <= t_sec < s['t1'] - 1e-5:
                if s['mood'] == 'suspension':
                    return 0.24
                return float(0.28 + 0.72 * (s['energy'] ** 1.38))
        return 0.85

    # 1) Harmony 声部（呼吸段泛音持续音 Fermata Breath 写入独立 breath_bus，精准定标在 -29..-31 dBFS！）
    harm_pans = (-0.20, 0.18, -0.08, 0.12)
    for idx_n, ev in enumerate(tracks['harmony']):
        is_breath = (ev.get('role') == 'fermata_breath_pedal')
        ov_in = 0.0 if ev['t0'] <= 1e-4 else (0.08 if is_breath else 0.075)
        # 若开启了 pad_tail_s，将终章最后一个和弦无缝延续至 total_dur，防 AI Cover 提前衰减！
        t1_eff = total_dur if (tail_s > 0.0 and abs(ev['t1'] - base_dur) <= 0.05) else ev['t1']
        ov_out = 0.0 if abs(t1_eff - total_dur) <= 1e-4 else (0.10 if is_breath else 0.11)
        wt0 = max(0.0, ev['t0'] - ov_in)
        wt1 = min(total_dur, t1_eff + ov_out)
        dur_n = wt1 - wt0
        if dur_n <= 0.03:
            continue
        timb = 'flageolet' if is_breath else orch['harmony_timbre']
        wave = _synth_sustained_instrument(midi_to_hz(ev['midi']), dur_n, synth_sr, r, timbre=timb, vel=ev['vel'])
        if tail_s > 0.0 and t1_eff > base_dur + 0.05:
            # 延续段平滑缓降余韵，保证 base_dur 处依然饱满在线，而在 total_dur 末端自然淡隐
            t_local = np.linspace(wt0, wt1, len(wave), dtype=np.float64)
            over_t = np.maximum(0.0, t_local - base_dur)
            wave = wave * np.exp(-0.38 * over_t)
        if is_breath:
            pan_v = -0.10 + 0.10 * (idx_n % 3)
            _place_mono_or_stereo(breath_bus, wave, int(round(wt0 * synth_sr)), gain=0.46, pan=pan_v)
        else:
            sg = _sec_gain_at(ev['t0'])
            pan_v = harm_pans[idx_n % len(harm_pans)]
            _place_mono_or_stereo(mix_bus, wave, int(round(wt0 * synth_sr)), gain=sg * 0.86, pan=pan_v)

    # 2) Bass 声部（居中稳固底盘；playful_folk 高潮段在拨奏外叠入柔和拉弦低音保终章饱满度）
    for ev in tracks['bass']:
        t1_eff = total_dur if (tail_s > 0.0 and abs(ev['t1'] - base_dur) <= 0.05) else ev['t1']
        wt0 = max(0.0, ev['t0'] - (0.0 if ev['t0'] <= 1e-4 else 0.05))
        wt1 = min(total_dur, t1_eff + (0.0 if abs(t1_eff - total_dur) <= 1e-4 else 0.08))
        dur_n = wt1 - wt0
        if dur_n <= 0.03:
            continue
        sg_b = _sec_gain_at(ev['t0'])
        if orch['bass_timbre'] == 'pizz_bass':
            wave = _synth_plucked_or_struck(midi_to_hz(ev['midi']), min(dur_n, 0.95), synth_sr, r, timbre='pizz_bass', vel=ev['vel'])
            _place_mono_or_stereo(mix_bus, wave, int(round(wt0 * synth_sr)), gain=sg_b * 0.90, pan=0.0)
            if sg_b >= 0.78:
                arc_bow = _synth_sustained_instrument(midi_to_hz(ev['midi']), dur_n, synth_sr, r, timbre='cello', vel=ev['vel'] * 0.85)
                if tail_s > 0.0 and t1_eff > base_dur + 0.05:
                    t_local = np.linspace(wt0, wt1, len(arc_bow), dtype=np.float64)
                    arc_bow = arc_bow * np.exp(-0.38 * np.maximum(0.0, t_local - base_dur))
                _place_mono_or_stereo(mix_bus, arc_bow, int(round(wt0 * synth_sr)), gain=sg_b * 0.78, pan=0.0)
        else:
            wave = _synth_sustained_instrument(midi_to_hz(ev['midi']), dur_n, synth_sr, r, timbre='cello', vel=ev['vel'])
            if tail_s > 0.0 and t1_eff > base_dur + 0.05:
                t_local = np.linspace(wt0, wt1, len(wave), dtype=np.float64)
                wave = wave * np.exp(-0.38 * np.maximum(0.0, t_local - base_dur))
            _place_mono_or_stereo(mix_bus, wave, int(round(wt0 * synth_sr)), gain=sg_b * 0.92, pan=0.0)

    # 3) Melody 动机主旋律与对位声部
    for ev in tracks['melody']:
        t1_eff = total_dur if (tail_s > 0.0 and ev.get('role') == 'final_tonic_hold' and abs(ev['t1'] - base_dur) <= 0.10) else ev['t1']
        dur_n = min(total_dur, t1_eff + 0.06) - ev['t0']
        if dur_n <= 0.03:
            continue
        is_cnt = (ev.get('role') == 'counter_melody')
        timb = orch['counter_timbre'] if is_cnt else orch['melody_timbre']
        if timb in ('felt_piano', 'pipa', 'guqin', 'marimba', 'guzheng', 'harp'):
            wave = _synth_plucked_or_struck(midi_to_hz(ev['midi']), max(dur_n, 0.38), synth_sr, r, timbre=timb, vel=ev['vel'])
        else:
            wave = _synth_sustained_instrument(midi_to_hz(ev['midi']), dur_n, synth_sr, r, timbre=timb, vel=ev['vel'])
        pan_m = -0.14 if is_cnt else 0.06
        _place_mono_or_stereo(mix_bus, wave, int(round(ev['t0'] * synth_sr)), gain=_sec_gain_at(ev['t0']) * 1.02, pan=pan_m)

    # 4) Arpeggio 与弱起上行刮奏（Anacrusis Glissando 写入 breath_bus 形成温润渐强推浪）
    for idx_a, ev in enumerate(tracks['arpeggio']):
        dur_n = min(total_dur, ev['t1']) - ev['t0']
        if dur_n <= 0.02:
            continue
        is_gliss = ev.get('role') in ('anacrusis_gliss', 'transition_gliss')
        timb = ('guzheng' if style in ('chinese_chamber', 'ink_poetic') else 'harp') if is_gliss else orch['arp_timbre']
        wave = _synth_plucked_or_struck(midi_to_hz(ev['midi']), dur_n, synth_sr, r, timbre=timb, vel=ev['vel'])
        pan_a = (-0.24 + 0.09 * (idx_a % 6)) if is_gliss else (0.20 * math.sin(0.9 * idx_a))
        if ev.get('role') == 'anacrusis_gliss':
            _place_mono_or_stereo(breath_bus, wave, int(round(ev['t0'] * synth_sr)), gain=0.22, pan=pan_a)
        else:
            sg = 0.42 if is_gliss else (_sec_gain_at(ev['t0']) * 0.80)
            _place_mono_or_stereo(mix_bus, wave, int(round(ev['t0'] * synth_sr)), gain=sg, pan=pan_a)

    # 5) Percussion（定音鼓/堂鼓正拍与弱起渐强滚奏；suspension 呼吸核心严格静音）
    for ev in tracks['percussion']:
        dur_n = min(total_dur, ev['t1']) - ev['t0']
        if dur_n <= 0.02:
            continue
        wave = _synth_percussion_note(midi_to_hz(ev['midi']), dur_n, synth_sr, r, role=ev.get('role', 'climax_timpani'), vel=ev['vel'])
        if ev.get('role') == 'anacrusis_roll':
            _place_mono_or_stereo(breath_bus, wave, int(round(ev['t0'] * synth_sr)), gain=0.18, pan=-0.05)
        else:
            _place_mono_or_stereo(mix_bus, wave, int(round(ev['t0'] * synth_sr)), gain=_sec_gain_at(ev['t0']) * 0.85, pan=-0.05)

    # 6) 音乐厅/室内乐早期反射与混响：先收束悬停段内前句主混响残尾，再精确叠入清透 breath_bus！
    ir = make_ir(rt=float(orch['reverb_rt']), pre=0.016, er=8, seed=eff_seed + 17, length=min(2.0, float(orch['reverb_rt']) + 0.3))
    src_hp = sosfilt(butter(2, 150.0, 'high', fs=float(synth_sr), output='sos'), mix_bus, axis=0)
    wet_l = fftconvolve(0.76 * src_hp[:, 0] + 0.24 * src_hp[:, 1], ir[:, 0])[:n_synth]
    wet_r = fftconvolve(0.76 * src_hp[:, 1] + 0.24 * src_hp[:, 0], ir[:, 1])[:n_synth]
    main_wet = mix_bus + float(orch['reverb_wet']) * np.stack([wet_l, wet_r], axis=1)

    t_axis = np.arange(n_synth, dtype=np.float64) / float(synth_sr)
    tail_damp = np.ones(n_synth, dtype=np.float64)
    for s in secs:
        if s['mood'] == 'suspension':
            st0, st1 = s['t0'], s['t1']
            if st1 - st0 >= 0.22:
                dip_in = smoothstep(st0, min(st0 + 0.16, st1), t_axis)
                dip_out = 1.0 - smoothstep(max(st0, st1 - 0.08), st1, t_axis)
                tail_damp *= (1.0 - 0.88 * dip_in * dip_out)

    # 对 breath_bus 施加轻柔混响光泽并与非呼吸主能量自动校准至 -29.5 dBFS 相对比值
    br_hp = sosfilt(butter(2, 180.0, 'high', fs=float(synth_sr), output='sos'), breath_bus, axis=0)
    br_wl = fftconvolve(0.75 * br_hp[:, 0] + 0.25 * br_hp[:, 1], ir[:, 0])[:n_synth]
    br_wr = fftconvolve(0.75 * br_hp[:, 1] + 0.25 * br_hp[:, 0], ir[:, 1])[:n_synth]
    breath_wet = breath_bus + 0.20 * np.stack([br_wl, br_wr], axis=1)

    # 自适应锚定悬停呼吸电平：相对 climax RMS 固定低约 16.5 dB（归一化后稳居 -28 ~ -31 dBFS，100ms 最低窗 > -34 dBFS！）
    climax_spans = [main_wet[int(s['t0'] * synth_sr):int(s['t1'] * synth_sr)] for s in secs if s['mood'] == 'climax' and s['t1'] > s['t0'] + 0.1]
    if climax_spans and np.any(np.abs(breath_wet) > 1e-9):
        c_rms = float(np.sqrt(np.mean(np.vstack(climax_spans) ** 2) + 1e-24))
        for s in secs:
            if s['mood'] == 'suspension' and s['t1'] - s['t0'] >= 0.25:
                i0 = int(round(s['t0'] * synth_sr))
                i1 = min(n_synth, int(round(s['t1'] * synth_sr)))
                pk_lead = float(np.clip(0.36 * (s['t1'] - s['t0']), 0.28, 0.42)) if (s['t1'] - s['t0']) >= 0.45 else 0.15 * (s['t1'] - s['t0'])
                ic = max(i0 + 8, int(round((s['t1'] - pk_lead) * synth_sr)))
                core_cur = float(np.sqrt(np.mean(breath_wet[i0:ic] ** 2) + 1e-24))
                if core_cur > 1e-9 and c_rms > 1e-9:
                    target_core = c_rms * float(undb(-17.2))
                    breath_wet[i0:i1] *= (target_core / core_cur)

    wet_mix = main_wet * tail_damp[:, None] + breath_wet

    # 清理次声波与直流偏移 + 温和软膝峰值驯服（防止孤立瞬态拉低全曲平均响度，同时零谐波失真）
    wet_mix = sosfilt(butter(2, 30.0, 'high', fs=float(synth_sr), output='sos'), wet_mix, axis=0)
    wet_mix = wet_mix - np.mean(wet_mix, axis=0, keepdims=True)
    rms_all = float(np.sqrt(np.mean(wet_mix ** 2) + 1e-24))
    if rms_all > 1e-9:
        knee_ceil = 3.15 * rms_all
        mag = np.abs(wet_mix)
        over = mag > knee_ceil
        if np.any(over):
            compressed = knee_ceil + (0.65 * knee_ceil) * np.tanh((mag[over] - knee_ceil) / (0.65 * knee_ceil))
            wet_mix = wet_mix.copy()
            wet_mix[over] = np.sign(wet_mix[over]) * compressed

    n_out = max(2, int(round(total_dur * sr_out)))
    if sr_out != synth_sr:
        import soxr
        out_st = soxr.resample(wet_mix, synth_sr, sr_out)
        if len(out_st) < n_out:
            out_st = np.vstack([out_st, np.zeros((n_out - len(out_st), 2), dtype=np.float64)])
        else:
            out_st = out_st[:n_out].copy()
    else:
        out_st = wet_mix[:n_out]

    fin_s = min(0.012, 0.15 * total_dur)
    fout_s = min(0.28 if tail_s > 0 else 0.080, 0.20 * total_dur)
    out_st = fade(out_st, fin=fin_s, fout=fout_s)

    target_pk = float(undb(float(peak_dbfs)))
    cur_pk = float(np.max(np.abs(out_st)))
    if cur_pk > 1e-12:
        out_st = out_st * (target_pk / cur_pk)
    out_st = np.nan_to_num(out_st, nan=0.0, posinf=0.0, neginf=0.0)
    out_st[0] = 0.0
    out_st[-1] = 0.0
    return out_st


# ───────────────────────── 纯 Python 标准 SMF Type-1 (.mid) 导出器 ─────────────────────────

def _encode_vlq(value: int) -> bytes:
    v = max(0, int(value))
    buf = [v & 0x7F]
    v >>= 7
    while v > 0:
        buf.append((v & 0x7F) | 0x80)
        v >>= 7
    buf.reverse()
    return bytes(buf)


def _meta_event(delta: int, meta_type: int, payload: bytes) -> bytes:
    return _encode_vlq(delta) + bytes([0xFF, meta_type & 0xFF]) + _encode_vlq(len(payload)) + payload


def _build_mtrk(raw_events: list[tuple[int, int, bytes]]) -> bytes:
    """将 [(tick, sort_prio, midi_or_meta_bytes), ...] 编码为标准 MTrk 块。"""
    sorted_evs = sorted(raw_events, key=lambda x: (x[0], x[1]))
    chunks: list[bytes] = []
    prev_tick = 0
    for tick, _, msg in sorted_evs:
        dt = max(0, int(tick) - prev_tick)
        prev_tick = max(prev_tick, int(tick))
        chunks.append(_encode_vlq(dt) + msg)
    chunks.append(b'\x00\xFF\x2F\x00')  # End of Track
    body = b''.join(chunks)
    return b'MTrk' + struct.pack('>I', len(body)) + body


def export_midi(score: dict, out_path: str, *, ticks_per_beat: int = 480) -> str:
    """将 compose_film_score 生成的总谱导出为标准 SMF Type-1 多轨 `.mid` 二进制文件（零外部依赖）。"""
    tpb = max(96, int(ticks_per_beat))
    bpm = float(score.get('bpm', 96.0))
    us_per_beat = max(1, int(round(60_000_000.0 / max(20.0, bpm))))
    style = score.get('style') or 'cinematic_orchestral'
    gm_map = GM_PROGRAMS.get(style, GM_PROGRAMS['cinematic_orchestral'])

    def _sec_to_tick(t_sec: float) -> int:
        return max(0, int(round(float(t_sec) * (bpm / 60.0) * tpb)))

    mtrks: list[bytes] = []

    # Track 0：速度、拍号、分段标记与和弦符号导引轨
    cond_evs: list[tuple[int, int, bytes]] = []
    title_bytes = f"Beiming-{style}-{score.get('key', 'D')}-{score.get('scale', 'major')}".encode('utf-8')
    cond_evs.append((0, 0, b'\xFF\x03' + _encode_vlq(len(title_bytes)) + title_bytes))
    cond_evs.append((0, 1, b'\xFF\x58\x04\x04\x02\x18\x08'))  # 4/4 time signature
    cond_evs.append((0, 2, b'\xFF\x51\x03' + us_per_beat.to_bytes(3, 'big')))
    for sec in score.get('sections') or []:
        marker = f"{sec['id']}:{sec['mood']}".encode('utf-8')
        cond_evs.append((_sec_to_tick(sec['t0']), 3, b'\xFF\x06' + _encode_vlq(len(marker)) + marker))
    for chd in score.get('chords') or []:
        c_txt = str(chd.get('symbol') or '').encode('utf-8')
        if c_txt:
            cond_evs.append((_sec_to_tick(chd['t0']), 4, b'\xFF\x01' + _encode_vlq(len(c_txt)) + c_txt))
    mtrks.append(_build_mtrk(cond_evs))

    track_order = (
        ('melody', 0),
        ('harmony', 1),
        ('bass', 2),
        ('arpeggio', 3),
        ('percussion', 4),
    )
    tracks_dict = score.get('tracks') or {}
    for tr_name, ch in track_order:
        notes = tracks_dict.get(tr_name) or []
        if not notes:
            continue
        tr_evs: list[tuple[int, int, bytes]] = []
        nm_b = tr_name.encode('ascii')
        tr_evs.append((0, 0, b'\xFF\x03' + _encode_vlq(len(nm_b)) + nm_b))
        prog = int(np.clip(gm_map.get(tr_name, 0), 0, 127))
        tr_evs.append((0, 1, bytes([0xC0 | (ch & 0x0F), prog])))
        for n in notes:
            t_on = _sec_to_tick(n['t0'])
            t_off = max(t_on + 12, _sec_to_tick(n['t1']))
            pitch = int(np.clip(round(n['midi']), 0, 127))
            vel = int(np.clip(round(float(n.get('vel', 0.75)) * 120.0), 1, 127))
            tr_evs.append((t_on, 3, bytes([0x90 | (ch & 0x0F), pitch, vel])))
            tr_evs.append((t_off, 2, bytes([0x80 | (ch & 0x0F), pitch, 0])))
        mtrks.append(_build_mtrk(tr_evs))

    header = b'MThd' + struct.pack('>IHHH', 6, 1, len(mtrks), tpb)
    midi_bytes = header + b''.join(mtrks)

    abs_out = os.path.abspath(out_path)
    parent = os.path.dirname(abs_out)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f'{abs_out}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp.mid'
    try:
        with open(tmp, 'wb') as f:
            f.write(midi_bytes)
        os.replace(tmp, abs_out)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return abs_out
