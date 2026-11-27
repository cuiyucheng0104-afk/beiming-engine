#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WonderX Phase 2 v4 原创高科技配乐（三轨无缝循环分轨）与物理因果拟音生成管线。

音源与许可：
  - 算法作曲与声部连接：engine/audio/composer.py（MIT，本仓库原创）
  - 采样器与编配：engine/audio/orchestra.py + engine/audio/sampler.py（MIT，本仓库原创）
  - 多采样真声乐器：Versilian Studios VSCO 2 CE & VCSL（CC0-1.0，逐文件校验 samples.json 字节数/git blob SHA-1/SHA-256）
  - 物理因果拟音：engine/audio/procedural.py（MIT，本仓库原创，严格不含 R01/R02/YuE2/A05/B03）
  - 母带与响度测量：engine/audio/mixing.py + engine/audio/meter.py（MIT，本仓库原创）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from engine.audio import composer as C
from engine.audio import dsp as D
from engine.audio import meter as M
from engine.audio import mixing as X
from engine.audio import orchestra as O
from engine.audio import procedural as P
from engine.audio import sampler as S

SR = D.SR  # 48000 Hz


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1_file(path: Path) -> str:
    data = path.read_bytes()
    h = hashlib.sha1()
    h.update(f'blob {len(data)}\0'.encode('ascii'))
    h.update(data)
    return h.hexdigest()


def wrap_seamless_loop(stereo_buf: np.ndarray, loop_samples: int, xfade_s: float = 0.06) -> np.ndarray:
    """将超出循环长度的混响/释音尾无缝折返叠加回循环头部，消除首尾拼接咔哒声。"""
    out = np.zeros((loop_samples, 2), dtype=np.float64)
    n_main = min(len(stereo_buf), loop_samples)
    out[:n_main] += stereo_buf[:n_main]
    if len(stereo_buf) > loop_samples:
        tail = stereo_buf[loop_samples:]
        m = min(len(tail), loop_samples)
        # 尾部末尾做短暂淡出避免折返残尾突断
        fade_len = min(m, int(0.4 * SR))
        if fade_len > 0:
            tail = tail[:m].copy()
            tail[-fade_len:] *= np.linspace(1.0, 0.0, fade_len)[:, None]
        out[:m] += tail[:m]
    # 极短头尾平滑防极微小直流偏移
    xf = min(int(xfade_s * SR), loop_samples // 16)
    if xf > 8:
        ramp = np.linspace(0.0, 1.0, xf)[:, None]
        edge = 0.5 * (out[:xf] + out[-xf:])
        out[:xf] = out[:xf] * ramp + edge * (1.0 - ramp)
        out[-xf:] = out[-xf:] * (1.0 - ramp) + edge * ramp
    return out


def synth_obsidian_pad(midi_note: float, dur: float, vel: float = 0.7) -> np.ndarray:
    """高科技曜石晶体铺底音色：严格 A4=440Hz 零失谐，带细微光学泛音漂移。"""
    n = max(16, int((dur + 1.2) * SR))
    t = np.arange(n, dtype=np.float64) / SR
    f0 = C.midi_to_hz(midi_note)
    # 温润基频 + 轻八度玻璃泛音 + 极克制五度泛音
    phase1 = 2.0 * math.pi * f0 * t
    phase2 = 2.0 * math.pi * (f0 * 2.0) * t + 0.12 * np.sin(2.0 * math.pi * 0.25 * t)
    phase3 = 2.0 * math.pi * (f0 * 3.0) * t
    sig = (
        0.62 * np.sin(phase1)
        + 0.22 * np.sin(phase2) * (0.65 + 0.35 * np.sin(2.0 * math.pi * 0.18 * t))
        + 0.08 * np.sin(phase3)
        + 0.06 * np.sin(phase1 * 0.5)  # 轻厚次低频支撑
    )
    atk = min(0.45, dur * 0.3)
    rel = 1.15
    env = np.ones(n, dtype=np.float64)
    na = max(1, int(atk * SR))
    env[:na] = np.sin(0.5 * math.pi * np.linspace(0.0, 1.0, na)) ** 2
    n_on = min(n, int(dur * SR))
    nr = max(1, n - n_on)
    env[n_on:] = np.cos(0.5 * math.pi * np.linspace(0.0, 1.0, nr)) ** 2
    y = D.lp(sig * env, min(2800.0, f0 * 6.0), 2)
    return (y * float(vel) * 0.22).astype(np.float64)


def synth_tech_pulse_kick(dur: float = 0.24, f_start: float = 112.0, f_end: float = 44.0) -> np.ndarray:
    """精密低频脉冲底鼓（无噪点、干净收紧，适配科技演示室监听）。"""
    n = int(dur * SR)
    t = np.arange(n, dtype=np.float64) / SR
    freq = f_end + (f_start - f_end) * np.exp(-t / 0.022)
    phase = 2.0 * math.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-t / 0.075)
    click = np.sin(2.0 * math.pi * 1450.0 * t) * np.exp(-t / 0.004) * 0.14
    y = D.hp(body + click, 30.0, 2)
    return (y * 0.42).astype(np.float64)


def synth_telemetry_tick(seed: int = 1, bright: bool = False) -> np.ndarray:
    """极短精密时钟滴答（32ms，清脆高频定位感）。"""
    r = D.rng(seed)
    n = int(0.036 * SR)
    t = np.arange(n, dtype=np.float64) / SR
    f = 4600.0 if bright else 3100.0
    ping = np.sin(2.0 * math.pi * f * t) * np.exp(-t / 0.005)
    burst = D.bp(r.standard_normal(n), 2800.0, 7200.0, 2) * np.exp(-t / 0.004)
    return ((0.65 * ping + 0.35 * burst) * 0.14).astype(np.float64)


def synth_glass_bell(midi_note: float, dur: float, vel: float = 0.75) -> np.ndarray:
    """晶透光学钟琴补强层：精准锁定 A4=440Hz，与 Versilian Glockenspiel 叠层融合成现代科技音色。"""
    n = max(16, int((dur + 1.0) * SR))
    t = np.arange(n, dtype=np.float64) / SR
    f0 = C.midi_to_hz(midi_note)
    sig = (
        0.60 * np.sin(2.0 * math.pi * f0 * t) * np.exp(-t / max(0.35, dur * 0.85))
        + 0.25 * np.sin(2.0 * math.pi * (f0 * 2.0) * t) * np.exp(-t / 0.32)
        + 0.10 * np.sin(2.0 * math.pi * (f0 * 3.0) * t) * np.exp(-t / 0.14)
        + 0.05 * np.sin(2.0 * math.pi * (f0 * 4.0) * t) * np.exp(-t / 0.06)
    )
    na = max(1, int(0.004 * SR))
    sig[:na] *= np.linspace(0.0, 1.0, na)
    return (sig * float(vel) * 0.24).astype(np.float64)


def apply_plate_reverb(st: np.ndarray, rt60: float = 1.35, wet: float = 0.20, seed: int = 77) -> np.ndarray:
    ir = D.make_ir(rt=rt60, pre=0.016, tone=(0.65, 1.0, 0.78, 0.45), seed=seed)
    pad = np.zeros((len(ir), 2), dtype=np.float64)
    padded = np.vstack([st, pad])
    return D.reverb(padded, ir, wet=wet, dry=1.0 - wet * 0.25, cross=0.30, hp_in=140.0)


def build_score_stems(samples_root: Path | None, loop_dur: float = 56.0, use_samples: bool = True) -> dict:
    """用 composer.py (hitech_minimal) + orchestra.py + CC0 Versilian 采样构建三轨相位锁定配乐。"""
    S.seed(20261127)
    O.USED.clear()
    if use_samples and samples_root is not None:
        S.ROOT = str(samples_root)
        S._cache.clear()

    # 7 段完整高科技叙事弧线，总长 loop_dur 秒（56.0s @ 120 BPM = 28 小节），无缝收束回主调 D Dorian
    scale_t = loop_dur / 56.0
    sections = [
        {'id': 'P1_establish',  't0': 0.0 * scale_t,  't1': 8.0 * scale_t,  'energy': 0.38, 'mood': 'establishing'},
        {'id': 'P2_breakout',   't0': 8.0 * scale_t,  't1': 16.0 * scale_t, 'energy': 0.56, 'mood': 'development'},
        {'id': 'P3_dissect',    't0': 16.0 * scale_t, 't1': 24.0 * scale_t, 'energy': 0.64, 'mood': 'development'},
        {'id': 'P4_prism',      't0': 24.0 * scale_t, 't1': 32.0 * scale_t, 'energy': 0.72, 'mood': 'rising'},
        {'id': 'P5_tsunami',    't0': 32.0 * scale_t, 't1': 40.0 * scale_t, 'energy': 0.86, 'mood': 'rising'},
        {'id': 'P6_breath',     't0': 40.0 * scale_t, 't1': 44.0 * scale_t, 'energy': 0.36, 'mood': 'suspension'},
        {'id': 'P7_climax_end', 't0': 44.0 * scale_t, 't1': 56.0 * scale_t, 'energy': 0.90, 'mood': 'climax'},
    ]
    events = [4.0 * scale_t, 8.0 * scale_t, 16.0 * scale_t, 24.0 * scale_t, 32.0 * scale_t, 44.0 * scale_t, 52.0 * scale_t]
    score = C.compose_film_score(
        sections,
        dur=loop_dur,
        fps=24,
        key='D',
        scale='dorian',
        bpm=120.0,
        style='hitech_minimal',
        prompt='hitech precision minimal telemetry crystal prism',
        events=events,
        seed=20261127,
    )

    pad_tail = 4.0
    n_loop = int(round(loop_dur * SR))
    n_buf = int(round((loop_dur + pad_tail) * SR))
    buf_pad = np.zeros((n_buf, 2), dtype=np.float64)
    buf_pulse = np.zeros((n_buf, 2), dtype=np.float64)
    buf_lead = np.zeros((n_buf, 2), dtype=np.float64)

    # ── Stem 1: PAD（和声声场：CC0 Versilian Cellos + Bowed Vibraphone + 曜石低频铺底） ──
    for note in score['tracks']['bass']:
        dur = max(0.35, note['t1'] - note['t0'])
        m = int(note['midi'])
        if use_samples:
            cello_m = max(36, min(60, m))
            O.sus(
                buf_pad, 'cellos', cello_m, note['t0'], note['t1'],
                pan=-0.12, gain_db=-7.5 + 3.0 * note['vel'],
                attack=0.22, release=0.55,
                dyn=((note['t0'], 0.35), (note['t0'] + dur * 0.45, note['vel']), (note['t1'], 0.45)),
                desks=2, spread=0.28,
            )
        sub = synth_obsidian_pad(max(36, m - 12 if m >= 50 else m), dur, vel=note['vel'] * 0.85)
        D.place(buf_pad, sub, note['t0'], 0.72, 0.0)

    for idx, note in enumerate(score['tracks']['harmony']):
        dur = max(0.35, note['t1'] - note['t0'])
        m = int(note['midi'])
        pan = (-0.36, 0.0, 0.36, 0.18)[idx % 4]
        if use_samples:
            vib_m = max(53, min(86, m))
            O.sus(
                buf_pad, 'vibraphone_bowed', vib_m, note['t0'], note['t1'],
                pan=pan, gain_db=-12.5 + 3.5 * note['vel'],
                attack=0.30, release=0.70,
                dyn=((note['t0'], 0.30), (note['t0'] + dur * 0.5, note['vel'] * 0.85), (note['t1'], 0.35)),
                desks=1, spread=0.14,
            )
        glass = synth_obsidian_pad(m, dur, vel=note['vel'] * 0.52)
        D.place(buf_pad, glass, note['t0'], 0.58, pan)

    # ── Stem 2: PULSE（脉冲节律：CC0 Versilian Harp 锁拍琶音 + Sus Cymbal 渐强 + 精密时钟脉动） ──
    for idx, note in enumerate(score['tracks']['arpeggio']):
        m = int(note['midi'])
        pan = -0.34 + 0.68 * ((idx % 4) / 3.0)
        if use_samples:
            harp_m = max(48, min(88, m))
            O.pluck(
                buf_pulse, 'harp', harp_m, note['t0'],
                vel=min(0.88, max(0.25, note['vel'] * 0.82)),
                pan=pan, gain_db=-9.5, dur=1.25, release=0.45,
            )
        else:
            bell = synth_glass_bell(m, 0.38, vel=note['vel'] * 0.55)
            D.place(buf_pulse, bell, note['t0'], 0.65, pan)

    # 精密 120 BPM 科技脉冲网格（呼吸挂留段自动静默让出空间）
    spb = 0.5  # 120 BPM
    kick_wave = synth_tech_pulse_kick()
    n_steps = int(loop_dur / (spb * 0.5))
    for k in range(n_steps):
        t_step = k * (spb * 0.5)
        # 呼吸悬停段 [40s..43.4s] 暂停底鼓
        if 40.0 * scale_t <= t_step < 43.4 * scale_t:
            continue
        sec_energy = 0.45
        for sc in sections:
            if sc['t0'] <= t_step < sc['t1']:
                sec_energy = sc['energy']
                break
        if k % 4 == 0 and sec_energy >= 0.48:
            D.place(buf_pulse, kick_wave, t_step, 0.34 + 0.32 * sec_energy, 0.0)
        if k % 2 == 1 and sec_energy >= 0.54:
            tk = synth_telemetry_tick(seed=1000 + k, bright=(k % 4 == 3))
            D.place(buf_pulse, tk, t_step, 0.30 + 0.25 * sec_energy, -0.22 if (k % 4 == 1) else 0.22)

    # 高潮段与破框节点用真实 CC0 Versilian 吊镲（sus_cymbal）推起空间张力
    if use_samples:
        for t_cym, key_word, g_db, pan in [
            (6.0 * scale_t, 'cresc_2', -16.0, -0.18),
            (30.0 * scale_t, 'cresc_2', -14.5, 0.18),
            (42.0 * scale_t, 'cresc_2', -13.0, 0.0),
            (44.0 * scale_t, 'hit_pp', -15.5, 0.12),
        ]:
            if t_cym < loop_dur - 0.5:
                try:
                    cym = S.hit('sus_cymbal', key_word, vel=0.55, dur=2.4)
                    O.USED.add('sus_cymbal')
                    D.place(buf_pulse, cym, t_cym, D.undb(g_db), pan)
                except Exception:
                    pass

    # ── Stem 3: LEAD（主奏光束：MotifEngine 单主题动机，CC0 Versilian Glockenspiel + Bowed Vibraphone + 光学铃） ──
    for idx, note in enumerate(score['tracks']['melody']):
        dur = max(0.18, note['t1'] - note['t0'])
        m = int(note['midi'])
        role = str(note.get('role', ''))
        is_counter = 'counter' in role
        pan = -0.24 if is_counter else 0.16 * math.sin(idx * 0.7)
        if use_samples:
            glock_m = max(65, min(98, m + (12 if m < 65 else 0)))
            O.pluck(
                buf_lead, 'glockenspiel', glock_m, note['t0'],
                vel=min(0.86, max(0.30, note['vel'] * (0.68 if is_counter else 0.85))),
                pan=pan, gain_db=-10.5 if is_counter else -8.0, dur=min(1.6, dur + 0.5),
            )
            if not is_counter and dur >= 0.45:
                vib_m = max(55, min(88, m))
                O.sus(
                    buf_lead, 'vibraphone_bowed', vib_m, note['t0'], note['t1'],
                    pan=-pan * 0.5, gain_db=-11.0,
                    attack=0.08, release=0.45,
                    dyn=((note['t0'], note['vel'] * 0.8), (note['t1'], note['vel'] * 0.4)),
                    desks=1,
                )
        bell = synth_glass_bell(m, dur, vel=note['vel'] * (0.55 if is_counter else 0.85))
        D.place(buf_lead, bell, note['t0'], 0.78, pan)

    # 空间混响 + 高通清理次声波 + 无缝头尾折返循环
    pad_wet = apply_plate_reverb(D.hp(buf_pad, 28.0, 2), rt60=1.65, wet=0.26, seed=101)
    pulse_wet = apply_plate_reverb(D.hp(buf_pulse, 32.0, 2), rt60=0.95, wet=0.14, seed=202)
    lead_wet = apply_plate_reverb(D.hp(buf_lead, 140.0, 2), rt60=1.45, wet=0.24, seed=303)

    stems = {
        'pad': wrap_seamless_loop(pad_wet, n_loop),
        'pulse': wrap_seamless_loop(pulse_wet, n_loop),
        'lead': wrap_seamless_loop(lead_wet, n_loop),
    }

    # 协同母带：按总和校准到 -14.2 LUFS / <= -1.5 dBTP，同比例回写三轨确保网页叠加后电平平衡且零削波
    raw_sum = stems['pad'] + stems['pulse'] + stems['lead']
    master_st, diag = X.master_chain(raw_sum, target_lufs=-14.2, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=2.8)
    raw_lufs = M.integrated(raw_sum)
    master_lufs = M.integrated(master_st)
    delta_db = master_lufs - raw_lufs
    scale = float(D.undb(delta_db))
    for k in stems:
        y = stems[k] * scale
        # 各自安全防削波（-2.0 dBTP）
        y_lim, _ = D.tp_limit(y, -2.0, look=0.004, rel=0.08)
        stems[k] = y_lim.astype(np.float32)

    # 核对使用到的实际采样文件（严格从 sampler._cache 中提取被读取过的音频路径）
    used_wav_paths = sorted({k[1] for k in S._cache.keys() if isinstance(k, tuple) and len(k) == 2 and k[0] == 'audio'})

    return {
        'stems': stems,
        'master': master_st.astype(np.float32),
        'master_diag': diag,
        'score_meta': {
            'key': score['key'],
            'scale': score['scale'],
            'bpm': score['bpm'],
            'style': score['style'],
            'motif': score['motif'],
            'voice_leading': score['voice_leading'],
            'used_instruments': sorted(O.USED),
            'loop_dur_s': loop_dur,
        },
        'used_wav_paths': used_wav_paths,
    }


def build_procedural_sfx() -> dict[str, np.ndarray]:
    """用 engine/audio/procedural.py (MIT) 原创合成 6 组高科技交互与节拍拟音。"""
    sfx: dict[str, np.ndarray] = {}

    # 1. Act 01 Beat 3 朱红激光斩裂（破空 + 玻璃金属共振瞬态）
    w1, _ = P.aerodynamic_whoosh(0.55, profile='scifi_pass', diameter_m=0.014, weight=0.6, seed=11)
    m1, _ = P.modal_impact('metal_plate', dur=0.45, hardness=0.88, size_scale=0.65, damp_scale=1.2, key='D', seed=12)
    g1, _ = P.modal_impact('glass_crystal', dur=0.50, hardness=0.92, size_scale=0.55, damp_scale=0.9, key='D', seed=13)
    n1 = int(0.85 * SR)
    b1 = np.zeros((n1, 2), dtype=np.float64)
    D.place(b1, w1, 0.0, 0.72, -0.15)
    D.place(b1, m1, 0.14, 0.55, 0.10)
    D.place(b1, g1, 0.16, 0.42, 0.22)
    sfx['sfx_laser_cut'] = b1

    # 2. Act 03 六层同轴钛合金爆炸拆解（精密伺服微响 + 滚珠滑移）
    m2a, _ = P.modal_impact('metal_plate', dur=0.22, hardness=0.78, size_scale=0.45, damp_scale=1.8, key='A', seed=21)
    p2, _ = P.phisem_particles(0.62, count=34, density=1.1, material='beads', damp=0.015, seed=22)
    w2, _ = P.aerodynamic_whoosh(0.58, profile='scifi_pass', diameter_m=0.028, weight=0.45, seed=23)
    n2 = int(0.95 * SR)
    b2 = np.zeros((n2, 2), dtype=np.float64)
    D.place(b2, m2a, 0.0, 0.48, 0.0)
    D.place(b2, p2, 0.04, 0.50, -0.18)
    D.place(b2, w2, 0.08, 0.58, 0.15)
    sfx['sfx_mech_explode'] = b2

    # 3. Act 04 水晶棱镜光谱色散（高纯晶体共振 + 银片泛音）
    g3, _ = P.modal_impact('glass_crystal', dur=1.1, hardness=0.65, size_scale=0.85, damp_scale=0.65, key='D', seed=31)
    d3, _ = P.bouncing_disc(0.85, material='jade_token', bounces=5, spin_tail=False, size_scale=0.9, seed=32)
    n3 = int(1.35 * SR)
    b3 = np.zeros((n3, 2), dtype=np.float64)
    D.place(b3, g3, 0.0, 0.62, -0.10)
    D.place(b3, d3, 0.06, 0.35, 0.0)
    sfx['sfx_prism_chime'] = b3

    # 4. Act 05 三万动态体素阵列跃迁/重力涟漪（粒子涌流 + 深潜气流）
    p4, _ = P.phisem_particles(0.95, count=56, density=1.35, material='glass_shards', damp=0.012, seed=41)
    w4, _ = P.aerodynamic_whoosh(0.90, profile='wing_gust', diameter_m=0.036, weight=0.72, seed=42)
    n4 = int(1.20 * SR)
    b4 = np.zeros((n4, 2), dtype=np.float64)
    D.place(b4, p4, 0.0, 0.52, 0.08)
    D.place(b4, w4, 0.05, 0.68, -0.08)
    sfx['sfx_quantum_surge'] = b4

    # 5. Act 07 H5b 瞬时画风快门切换（干脆 <220ms 机械快门触发）
    m5, _ = P.modal_impact('ceramic', dur=0.14, hardness=0.92, size_scale=0.38, damp_scale=2.2, key='D', seed=51)
    g5, _ = P.modal_impact('glass_crystal', dur=0.18, hardness=0.85, size_scale=0.32, damp_scale=1.9, key='A', seed=52)
    n5 = int(0.24 * SR)
    b5 = np.zeros((n5, 2), dtype=np.float64)
    D.place(b5, m5, 0.0, 0.65, 0.0)
    D.place(b5, g5, 0.015, 0.42, 0.12)
    sfx['sfx_shader_snap'] = b5

    # 6. Act 02 / Act 06 / Act 09 / Act 10 穿镜/拉幕空间跃迁
    w6, _ = P.aerodynamic_whoosh(0.88, profile='scifi_pass', diameter_m=0.020, weight=0.65, seed=61)
    n6 = int(1.05 * SR)
    b6 = np.zeros((n6, 2), dtype=np.float64)
    D.place(b6, w6, 0.0, 0.75, 0.0)
    sfx['sfx_portal_whoosh'] = b6

    # 统一归一化与防削波
    out: dict[str, np.ndarray] = {}
    for k, buf in sfx.items():
        y = D.hp(buf, 35.0, 2)
        pk = float(np.abs(y).max()) or 1.0
        y = y * (D.undb(-3.0) / pk)
        y, _ = D.tp_limit(y, -1.8, look=0.003, rel=0.06)
        out[k] = y.astype(np.float32)
    return out


def verify_used_samples(used_wav_paths: list[str], samples_root: Path, manifest_path: Path) -> dict:
    """逐件核对实际使用到的每个 Versilian 采样文件：字节数、git blob SHA-1、SHA-256 与上游 CC0-1.0 许可。"""
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    libs = {l['id']: l for l in manifest['libraries']}
    index: dict[str, dict] = {}
    for inst_name, inst in manifest['instruments'].items():
        lib = libs[inst['library']]
        for f in inst['files']:
            rel = f"{lib['dir']}/{inst['dir']}/{f['path']}"
            index[rel] = {
                'instrument': inst_name,
                'library': lib['id'],
                'libraryName': lib['name'],
                'author': lib['author'],
                'license': lib['license'],
                'upstream': lib['upstream'],
                'commit': lib['commit'],
                'expected': f,
            }

    verified_files = []
    used_libs = set()
    problems = []
    for p_str in used_wav_paths:
        p = Path(p_str).resolve()
        rel = p.relative_to(samples_root.resolve()).as_posix()
        meta = index.get(rel)
        if not meta:
            problems.append(f'未在 samples.json 登记的采样：{rel}')
            continue
        actual_bytes = p.stat().st_size
        actual_blob = git_blob_sha1_file(p)
        actual_sha256 = sha256_file(p)
        exp = meta['expected']
        ok = (
            actual_bytes == exp['bytes']
            and actual_blob == exp['gitBlobSha1']
            and actual_sha256 == exp['sha256']
        )
        if not ok:
            problems.append(f'采样哈希不匹配：{rel}')
        used_libs.add(meta['library'])
        verified_files.append({
            'rel': rel,
            'instrument': meta['instrument'],
            'library': meta['library'],
            'license': meta['license'],
            'bytes': actual_bytes,
            'gitBlobSha1': actual_blob,
            'sha256': actual_sha256,
            'verified': ok,
        })

    # 同时核对所用两套库的 LICENSE 文件
    verified_licenses = []
    for lib_id in sorted(used_libs):
        lib = libs[lib_id]
        for ex in lib.get('extras', []):
            lp = samples_root / lib['dir'] / ex['path']
            actual_bytes = lp.stat().st_size
            actual_blob = git_blob_sha1_file(lp)
            actual_sha256 = sha256_file(lp)
            ok = (actual_bytes == ex['bytes'] and actual_blob == ex['gitBlobSha1'] and actual_sha256 == ex['sha256'])
            if not ok:
                problems.append(f'许可文件不匹配：{lib_id}/{ex["path"]}')
            verified_licenses.append({
                'library': lib_id,
                'name': lib['name'],
                'author': lib['author'],
                'license': lib['license'],
                'upstream': lib['upstream'],
                'commit': lib['commit'],
                'file': f"{lib['dir']}/{ex['path']}",
                'bytes': actual_bytes,
                'gitBlobSha1': actual_blob,
                'sha256': actual_sha256,
                'verified': ok,
            })

    if problems:
        raise RuntimeError('CC0 采样逐件核对失败：' + '; '.join(problems))
    return {
        'checkedCount': len(verified_files),
        'allVerified': True,
        'libraries': verified_licenses,
        'files': verified_files,
    }


def encode_opus(wav_path: Path, ogg_path: Path, bitrate: str = '56k', mono: bool = False) -> None:
    cmd = [
        'ffmpeg', '-y', '-v', 'error',
        '-i', str(wav_path),
        '-map_metadata', '-1',
        '-fflags', '+bitexact',
        '-flags:a', '+bitexact',
        '-c:a', 'libopus',
        '-b:a', bitrate,
        '-vbr', 'on',
        '-compression_level', '10',
        '-application', 'voip' if mono else 'audio',
        '-serial_offset', '1',
    ]
    if mono:
        cmd += ['-ac', '1']
    cmd += [str(ogg_path)]
    subprocess.run(cmd, check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--samples', default=os.environ.get('BEIMING_SAMPLES', ''), help='BEIMING_SAMPLES 目录')
    ap.add_argument('--out-dir', required=True, help='输出目录')
    ap.add_argument('--loop-dur', type=float, default=56.0, help='无缝循环配乐时长（秒）')
    ap.add_argument('--stem-bitrate', default='56k', help='分轨 Opus 码率')
    ap.add_argument('--sfx-bitrate', default='48k', help='拟音 Opus 码率')
    ap.add_argument('--bench-only', action='store_true', help='仅跑 12s 无采样 CPU 作曲与拟音基准（用于本机 vs 远端迁移耗时对照）')
    args = ap.parse_args()

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    t_start = time.monotonic()

    if args.bench_only:
        res = build_score_stems(None, loop_dur=12.0, use_samples=False)
        sfx = build_procedural_sfx()
        elapsed = time.monotonic() - t_start
        report = {
            'mode': 'bench-only',
            'loop_dur_s': 12.0,
            'sfx_count': len(sfx),
            'elapsed_s': round(elapsed, 4),
            'master_lufs': round(float(M.integrated(res['master'])), 3),
            'master_tp_db': round(20.0 * math.log10(max(float(M.true_peak(res['master'])), 1e-12)), 3),
        }
        (out_dir / 'bench-cpu.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
        return

    if not args.samples:
        raise SystemExit('请指定 --samples 或环境变量 BEIMING_SAMPLES')
    samples_root = Path(args.samples).resolve()
    manifest_path = REPO_ROOT / 'engine' / 'audio' / 'samples.json'

    res = build_score_stems(samples_root, loop_dur=args.loop_dur, use_samples=True)
    sfx = build_procedural_sfx()
    audit = verify_used_samples(res['used_wav_paths'], samples_root, manifest_path)

    wav_dir = out_dir / 'wav'
    ogg_dir = out_dir / 'opus'
    lic_dir = out_dir / 'licenses'
    wav_dir.mkdir(parents=True, exist_ok=True)
    ogg_dir.mkdir(parents=True, exist_ok=True)
    lic_dir.mkdir(parents=True, exist_ok=True)

    # 复制已校验的 CC0-1.0 许可全文
    for lib_info in audit['libraries']:
        src_lic = samples_root / lib_info['file']
        dst_lic = lic_dir / f"CC0-{lib_info['library']}-LICENSE.txt"
        shutil.copyfile(src_lic, dst_lic)

    # 写盘 WAV + 编码 Opus
    assets = []
    metrics = {}

    master_wav = wav_dir / 'score_master.wav'
    master_ogg = ogg_dir / 'score_master.ogg'
    sf.write(master_wav, res['master'], SR, subtype='PCM_24')
    encode_opus(master_wav, master_ogg, bitrate='96k')
    metrics['score_master'] = {
        'dur_s': round(len(res['master']) / SR, 3),
        'lufs': round(float(M.integrated(res['master'])), 2),
        'true_peak_db': round(20.0 * math.log10(max(float(M.true_peak(res['master'])), 1e-12)), 2),
        'wav_bytes': master_wav.stat().st_size,
        'ogg_bytes': master_ogg.stat().st_size,
        'ogg_sha256': sha256_file(master_ogg),
    }

    stem_names = {'pad': '和声声场', 'pulse': '脉冲节律', 'lead': '主奏光束'}
    for key, arr in res['stems'].items():
        w = wav_dir / f'stem_{key}.wav'
        o = ogg_dir / f'stem_{key}.ogg'
        sf.write(w, arr, SR, subtype='PCM_24')
        encode_opus(w, o, bitrate=args.stem_bitrate)
        o_bytes = o.stat().st_size
        o_sha = sha256_file(o)
        metrics[f'stem_{key}'] = {
            'dur_s': round(len(arr) / SR, 3),
            'lufs': round(float(M.integrated(arr)), 2),
            'true_peak_db': round(20.0 * math.log10(max(float(M.true_peak(arr)), 1e-12)), 2),
            'wav_bytes': w.stat().st_size,
            'ogg_bytes': o_bytes,
            'ogg_sha256': o_sha,
        }
        assets.append({
            'key': f'audio/stem_{key}.ogg',
            'id': key,
            'name': stem_names[key],
            'kind': 'audio_stem',
            'file': f'opus/stem_{key}.ogg',
            'mime': 'audio/ogg',
            'dur_s': round(len(arr) / SR, 3),
            'bytes': o_bytes,
            'sha256': o_sha,
        })

    for key, arr in sfx.items():
        w = wav_dir / f'{key}.wav'
        o = ogg_dir / f'{key}.ogg'
        sf.write(w, arr, SR, subtype='PCM_24')
        encode_opus(w, o, bitrate=args.sfx_bitrate)
        o_bytes = o.stat().st_size
        o_sha = sha256_file(o)
        metrics[key] = {
            'dur_s': round(len(arr) / SR, 3),
            'true_peak_db': round(20.0 * math.log10(max(float(M.true_peak(arr)), 1e-12)), 2),
            'wav_bytes': w.stat().st_size,
            'ogg_bytes': o_bytes,
            'ogg_sha256': o_sha,
        }
        assets.append({
            'key': f'audio/{key}.ogg',
            'id': key,
            'kind': 'audio_sfx',
            'file': f'opus/{key}.ogg',
            'mime': 'audio/ogg',
            'dur_s': round(len(arr) / SR, 3),
            'bytes': o_bytes,
            'sha256': o_sha,
        })

    elapsed = time.monotonic() - t_start
    audio_manifest = {
        'schemaVersion': 1,
        'sampleRate': SR,
        'score': res['score_meta'],
        'assets': assets,
        'vo': [],
    }
    report = {
        'elapsed_s': round(elapsed, 3),
        'score': res['score_meta'],
        'master_diag': {k: (round(float(v), 4) if isinstance(v, (int, float, np.floating)) else v) for k, v in res['master_diag'].items()},
        'metrics': metrics,
        'samples_audit': {
            'checkedCount': audit['checkedCount'],
            'allVerified': audit['allVerified'],
            'libraries': audit['libraries'],
        },
        'raw_opus_total_bytes': sum(a['bytes'] for a in assets),
    }
    (out_dir / 'manifest.json').write_text(json.dumps(audio_manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (out_dir / 'audio-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    (out_dir / 'used-samples-audit.json').write_text(json.dumps(audit, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
