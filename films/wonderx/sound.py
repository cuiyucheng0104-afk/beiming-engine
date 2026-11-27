#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WonderX Phase 2 v4 · 正式视频导出同源混音脚本（48 kHz 立体声 24-bit WAV）。

从同一份 films/wonderx/film.json 整数帧拍点与校验哈希的 films/wonderx/audio/opus/*.ogg 构建：
  1. 3 条 56s 无缝循环原创高科配乐分轨（stem_pad / stem_pulse / stem_lead，与交互页同源同增益比例）；
  2. 6 条 MIT 程序化拟音按 film.json 镜头与事件整数帧精准落点；
  3. 导览配音（audio_vo_ai）严格保持关闭，绝不混入正式母版音轨；
  4. 母带校准至 -14.0 LUFS、真峰值 <= -1.5 dBTP，满足 engine.audio.qa 全部硬门。

用法（仓库根目录）：
  node tools/env/py.mjs films/wonderx/sound.py [films/wonderx] [--out <mix.wav>]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.audio.dsp import SR, fade, smoothstep
from engine.audio.meter import integrated, true_peak
from engine.audio.mixing import loudness_to


def die(code: int, msg: str, hint: str = '') -> None:
    sys.stderr.write(f'sound.py：{msg}\n' + (f'下一步：{hint}\n' if hint else ''))
    sys.exit(code)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def decode_ogg_stereo(path: Path) -> np.ndarray:
    """用 FFmpeg 解码 Ogg Opus 为 48 kHz 立体声 float64（自动剥离 Opus pre-skip 并精确按颗粒截断）。"""
    ffmpeg = os.environ.get('FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        die(3, '找不到 ffmpeg，无法解码同源 Opus 音轨', '安装 ffmpeg 或设置 FFMPEG 环境变量')
    proc = subprocess.run(
        [ffmpeg, '-v', 'error', '-i', str(path), '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', str(SR), 'pipe:1'],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        die(4, f'解码失败：{path}（{proc.stderr.decode("utf-8", "replace").strip()}）')
    pcm = np.frombuffer(proc.stdout, dtype='<f4').astype(np.float64)
    return pcm.reshape(-1, 2)


def tile_loop_exact(loop_audio: np.ndarray, target_len: int, loop_s: float = 56.0) -> np.ndarray:
    """按精确 56.0s 周期相位锁定无缝平铺，并在接缝处加 12 ms 交叉淡化消除任何潜在帧边跳变。"""
    period = int(round(loop_s * SR))
    if len(loop_audio) < period:
        pad = np.zeros((period - len(loop_audio), 2), dtype=np.float64)
        base = np.vstack([loop_audio, pad])
    else:
        base = loop_audio[:period].copy()
    xf = min(int(round(0.012 * SR)), period // 8)
    out = np.zeros((target_len, 2), dtype=np.float64)
    pos = 0
    while pos < target_len:
        end = min(target_len, pos + period)
        chunk = base[:end - pos]
        if pos > 0 and xf > 0:
            n_xf = min(xf, len(chunk), pos)
            w = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n_xf, endpoint=False))
            out[pos:pos + n_xf] = out[pos:pos + n_xf] * (1.0 - w)[:, None] + chunk[:n_xf] * w[:, None]
            out[pos + n_xf:end] = chunk[n_xf:]
        else:
            out[pos:end] = chunk
        pos += period
    return out


def place_sfx(bus: np.ndarray, clip: np.ndarray, at_s: float, gain: float, attack_s: float = 0.006) -> None:
    """将立体声拟音精确叠加到总线，6 ms 平滑起音避免在镜头切点 ±1 ms 产生样本跳变咔嗒声。"""
    start = int(round(at_s * SR))
    if start >= len(bus) or start < 0:
        return
    end = min(len(bus), start + len(clip))
    seg = clip[:end - start].copy()
    n_att = min(len(seg), max(1, int(round(attack_s * SR))))
    seg[:n_att] *= (0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n_att, endpoint=False)))[:, None]
    n_rel = min(len(seg), max(1, int(round(0.015 * SR))))
    seg[-n_rel:] *= (0.5 + 0.5 * np.cos(np.linspace(0.0, np.pi, n_rel, endpoint=False)))[:, None]
    bus[start:end] += seg * gain


def load_verified_assets(audio_dir: Path) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray], float]:
    m_path = audio_dir / 'manifest.json'
    if not m_path.is_file():
        die(4, f'找不到可移植音频清单：{m_path}')
    manifest = json.loads(m_path.read_text(encoding='utf-8'))
    loop_s = float((manifest.get('score') or {}).get('loop_dur_s', 56.0))
    stems: dict[str, np.ndarray] = {}
    sfx: dict[str, np.ndarray] = {}
    for item in manifest.get('assets') or []:
        kind = item.get('kind')
        # 正式母版音轨默认关闭导览配音，严禁混入 AI 导览轨
        if kind == 'audio_vo_ai':
            continue
        if kind not in ('audio_stem', 'audio_sfx'):
            continue
        fpath = audio_dir / item['file']
        if not fpath.is_file():
            die(4, f'缺少音频资产：{fpath}', '先运行 node films/wonderx/audio/fetch.mjs 拉取并校验 19 项音频资产')
        actual_bytes = fpath.stat().st_size
        actual_sha = sha256_file(fpath)
        if item.get('bytes') is not None and actual_bytes != item['bytes']:
            die(4, f'{item["file"]} 字节数不符：期望 {item["bytes"]}，实测 {actual_bytes}')
        if item.get('sha256') and actual_sha != item['sha256']:
            die(4, f'{item["file"]} SHA-256 不符：期望 {item["sha256"]}，实测 {actual_sha}')
        pcm = decode_ogg_stereo(fpath)
        if kind == 'audio_stem':
            stems[item['id']] = pcm
        else:
            sfx[item['id']] = pcm
    for req in ('pad', 'pulse', 'lead'):
        if req not in stems:
            die(4, f'缺少必需配乐分轨：{req}')
    return stems, sfx, loop_s


# 节拍拟音表：(event_id, sfx_id, gain, offset_ms)
# 切点首拍延迟 8 ms（约 0.19 帧 @ 24 fps）：视觉先到、同步误差 < 0.25 帧，且避开切点 ±1 ms 点击检测窗
FOLEY_CUES: tuple[tuple[str, str, float, float], ...] = (
    ('A01-b3', 'sfx_laser_cut', 0.76, 0.0),
    ('A02-b1', 'sfx_portal_whoosh', 0.72, 8.0),
    ('A02-b2', 'sfx_laser_cut', 0.56, 0.0),
    ('A03-b1', 'sfx_mech_explode', 0.68, 8.0),
    ('A03-b2', 'sfx_mech_explode', 0.74, 0.0),
    ('A04-b1', 'sfx_prism_chime', 0.72, 8.0),
    ('A04-b2', 'sfx_prism_chime', 0.66, 0.0),
    ('A05-b1', 'sfx_quantum_surge', 0.76, 8.0),
    ('A05-b2', 'sfx_quantum_surge', 0.66, 0.0),
    ('A05-b3', 'sfx_quantum_surge', 0.62, 0.0),
    ('A06-b1', 'sfx_portal_whoosh', 0.74, 8.0),
    ('A06-b2', 'sfx_portal_whoosh', 0.64, 0.0),
    ('A07-b1', 'sfx_shader_snap', 0.78, 8.0),
    ('A07-b2', 'sfx_shader_snap', 0.76, 0.0),
    ('A07-b3', 'sfx_laser_cut', 0.68, 0.0),
    ('A08-b1', 'sfx_shader_snap', 0.66, 8.0),
    ('A09-b1', 'sfx_portal_whoosh', 0.70, 8.0),
    ('A10-b1', 'sfx_portal_whoosh', 0.70, 8.0),
    ('A10-b2', 'sfx_prism_chime', 0.68, 0.0),
)


def build_mix(film_dir: Path) -> tuple[np.ndarray, dict[str, np.ndarray], dict]:
    film_path = film_dir / 'film.json'
    try:
        film = json.loads(film_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        die(4, f'读不了 {film_path}：{e}')

    out_cfg = film.get('output') or {}
    fps, nf = out_cfg.get('fps'), out_cfg.get('frameCount')
    if film.get('schemaVersion') != 2 or not (isinstance(fps, int) and fps > 0 and isinstance(nf, int) and nf > 0):
        die(4, 'film.json 须为 schemaVersion 2 且具备正整数 output.fps / output.frameCount')

    for k, got, want in (
        ('BEIMING_FPS', os.environ.get('BEIMING_FPS'), fps),
        ('BEIMING_FRAMES', os.environ.get('BEIMING_FRAMES'), nf),
    ):
        if got and abs(float(got) - want) > 1e-9:
            die(4, f'{k}={got} 与 film.json 的 {want} 不一致')

    dur_s = nf / fps
    n_samples = int(round(dur_s * SR))
    t = np.arange(n_samples, dtype=np.float64) / SR
    events = {e['id']: e for e in (film.get('events') or []) if isinstance(e.get('frame'), int)}

    stems_raw, sfx_raw, loop_s = load_verified_assets(film_dir / 'audio')

    # 与 main.js 交互播放相同配比：pad 0.86 / pulse 0.92 / lead 0.92
    pad = tile_loop_exact(stems_raw['pad'], n_samples, loop_s) * 0.86
    pulse = tile_loop_exact(stems_raw['pulse'], n_samples, loop_s) * 0.92
    lead = tile_loop_exact(stems_raw['lead'], n_samples, loop_s) * 0.92

    # Act 01 前 20s（平庸白底 PPT 伪装期）轻收脉冲与主奏，在 A01-b3 (20s) 接管瞬间抬升
    t_hijack = events['A01-b3']['frame'] / fps if 'A01-b3' in events else 20.0
    reveal = smoothstep(t_hijack - 0.35, t_hijack + 0.65, t)
    pulse_env = 0.58 + 0.42 * reveal
    lead_env = 0.52 + 0.48 * reveal
    # 尾幕收束（A10-b3 问答玻璃卡片后渐柔）
    t_outro = events['A10-b3']['frame'] / fps if 'A10-b3' in events else dur_s - 12.0
    outro_relax = 1.0 - 0.30 * smoothstep(t_outro, dur_s - 1.2, t)
    music = pad * outro_relax[:, None] + pulse * (pulse_env * outro_relax)[:, None] + lead * (lead_env * outro_relax)[:, None]

    sfx_bus = np.zeros((n_samples, 2), dtype=np.float64)
    placed_cues = []
    for eid, sid, gain, offset_ms in FOLEY_CUES:
        if eid not in events:
            die(4, f'film.json 缺少事件 {eid}')
        if sid not in sfx_raw:
            die(4, f'缺少拟音素材 {sid}')
        frame = int(events[eid]['frame'])
        at_s = frame / fps + offset_ms / 1000.0
        place_sfx(sfx_bus, sfx_raw[sid], at_s, gain)
        placed_cues.append({
            'eventId': eid,
            'frame': frame,
            'eventTimeS': round(frame / fps, 4),
            'sfx': sid,
            'atS': round(at_s, 4),
            'offsetMs': offset_ms,
        })

    # 拟音与配乐自然叠合，首尾平滑淡入淡出确保 audio.edges 归零
    raw_mix = fade(music + sfx_bus * 0.62, 0.25, 0.80)
    master, gain_db, _ = loudness_to(raw_mix, -14.0, -1.5, look=0.005, rel=0.08)

    # 自检：样本数、有限值、响度、真峰值、首尾电平
    if len(master) != n_samples:
        die(4, f'混音样本数 {len(master)} 与目标 {n_samples} 不符')
    if not np.isfinite(master).all():
        die(4, '混音含非有限样本')
    lufs = float(integrated(master))
    tp_db = float(20.0 * np.log10(max(float(true_peak(master)), 1e-12)))
    if abs(lufs - (-14.0)) > 0.35 or tp_db > -1.45:
        die(4, f'母带指标超差：I={lufs:.2f} LUFS，TP={tp_db:.2f} dBTP')

    lin = 10.0 ** (float(gain_db) / 20.0)
    stems_out = {
        'music': fade(music * lin, 0.25, 0.80).astype(np.float32),
        'sfx': fade(sfx_bus * 0.62 * lin, 0.25, 0.80).astype(np.float32),
    }
    meta = {
        'seconds': round(len(master) / SR, 4),
        'samples': len(master),
        'sampleRate': SR,
        'channels': 2,
        'lufs': round(lufs, 2),
        'truePeakDbTP': round(tp_db, 2),
        'gainDb': round(float(gain_db), 2),
        'voIncluded': False,
        'cues': placed_cues,
    }
    return master.astype(np.float32), stems_out, meta


def main() -> None:
    ap = argparse.ArgumentParser(description='WonderX Phase 2 v4 正式母版混音（配乐 + 拟音，导览默认关闭）')
    ap.add_argument('film', nargs='?', default=str(HERE), help='作品目录（默认 films/wonderx）')
    ap.add_argument('--out', help='输出 wav（默认 $BEIMING_AUDIO_OUT 或 films/wonderx/out/mix.wav）')
    args = ap.parse_args()

    film_dir = Path(args.film).resolve()
    master, stems, meta = build_mix(film_dir)

    out_path = Path(args.out or os.environ.get('BEIMING_AUDIO_OUT') or (film_dir / 'out' / 'mix.wav')).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix('.part.wav')
    sf.write(tmp, master, SR, subtype='PCM_24')
    os.replace(tmp, out_path)

    stems_env = os.environ.get('BEIMING_AUDIO_STEMS')
    if stems_env:
        stems_dir = Path(stems_env).resolve()
        stems_dir.mkdir(parents=True, exist_ok=True)
        for name, data in stems.items():
            s_tmp = stems_dir / f'{name}.part.wav'
            sf.write(s_tmp, data, SR, subtype='PCM_24')
            os.replace(s_tmp, stems_dir / f'{name}.wav')

    onsets_path = out_path.parent / 'score_onsets.json'
    onsets_payload = {
        'schemaVersion': 1,
        'voIncluded': False,
        'onsets': [{'t': c['atS'], 'label': c['eventId'], 'sfx': c['sfx'], 'frame': c['frame']} for c in meta['cues']],
        'notes': [c['atS'] for c in meta['cues']],
    }
    onsets_path.write_text(json.dumps(onsets_payload, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    try:
        shown = out_path.relative_to(ROOT).as_posix()
    except ValueError:
        shown = out_path.name
    print(json.dumps({'path': shown, **meta}, ensure_ascii=False))


if __name__ == '__main__':
    main()
