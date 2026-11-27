#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""处理可选中文精华导览（VoxCPM2 CPU 纯文本音色设计，默认关闭）：
1. 轻裁首尾静音、75 Hz 高通、逐条校准至 -16.0 LUFS / <= -1.5 dBTP；
2. 编码单声道 Opus（28k）写入 out/audio/opus/vo_*.ogg；
3. 生成拼合试听文件 out/audio/vo_audition_all.wav 与 vo_audition_all.ogg；
4. 把 VO 资产与内联字节核算合并进 out/audio/manifest.json 与 out/audio/vo-report.json。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from engine.audio import dsp as D
from engine.audio import mixing as X

SR = D.SR


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def trim_and_clean(wav: np.ndarray, sr: int) -> np.ndarray:
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    x = D.hp(wav.astype(np.float64), 75.0, 2)
    win = max(1, int(0.03 * sr))
    rms = np.sqrt(np.convolve(x * x, np.ones(win) / win, mode='same'))
    nz = np.where(rms > 0.0065)[0]
    if len(nz):
        s = max(0, int(nz[0]) - int(0.04 * sr))
        e = min(len(x), int(nz[-1]) + int(0.09 * sr))
        x = x[s:e]
    x = D.fade(x, 0.012, 0.035)
    st = np.stack([x, x], axis=1)
    norm_st, _, _ = X.loudness_to(st, -16.0, -1.5, look=0.004, rel=0.08)
    return norm_st[:, 0].astype(np.float32)


def encode_opus_mono(wav_path: Path, ogg_path: Path, bitrate: str = '28k') -> None:
    subprocess.run([
        'ffmpeg', '-y', '-v', 'error',
        '-i', str(wav_path),
        '-map_metadata', '-1',
        '-fflags', '+bitexact',
        '-flags:a', '+bitexact',
        '-c:a', 'libopus',
        '-b:a', bitrate,
        '-vbr', 'on',
        '-compression_level', '10',
        '-application', 'voip',
        '-serial_offset', '1',
        '-ac', '1',
        str(ogg_path),
    ], check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--vo-dir', required=True)
    ap.add_argument('--batch', required=True)
    ap.add_argument('--audio-out', required=True)
    ap.add_argument('--bitrate', default='28k')
    args = ap.parse_args()

    vo_dir = Path(args.vo_dir).resolve()
    batch = json.loads(Path(args.batch).read_text(encoding='utf-8'))
    audio_out = Path(args.audio_out).resolve()
    ogg_dir = audio_out / 'opus'
    clean_dir = audio_out / 'vo_clean_wav'
    ogg_dir.mkdir(parents=True, exist_ok=True)
    clean_dir.mkdir(parents=True, exist_ok=True)

    vox_manifest_path = vo_dir / 'voxcpm2-manifest.json'
    vox_manifest = json.loads(vox_manifest_path.read_text(encoding='utf-8')) if vox_manifest_path.exists() else {}

    vo_assets = []
    vo_cues = []
    audition_chunks = []
    gap = np.zeros(int(0.55 * SR), dtype=np.float32)

    total_dur = 0.0
    total_raw_ogg = 0
    total_inline = 0

    for row in batch:
        cid = row['id']
        src = vo_dir / f'{cid}.wav'
        wav, sr = sf.read(src, dtype='float32')
        if sr != SR:
            raise RuntimeError(f'{src}: expected 48000 Hz, got {sr}')
        clean = trim_and_clean(wav, sr)
        dur = len(clean) / SR
        total_dur += dur

        c_wav = clean_dir / f'vo_{cid}.wav'
        c_ogg = ogg_dir / f'vo_{cid}.ogg'
        sf.write(c_wav, clean, SR, subtype='PCM_24')
        encode_opus_mono(c_wav, c_ogg, bitrate=args.bitrate)

        raw_bytes = c_ogg.stat().st_size
        b64_uri = f'data:audio/ogg;base64,{base64.b64encode(c_ogg.read_bytes()).decode("ascii")}'
        inline_bytes = len(b64_uri.encode('ascii'))
        total_raw_ogg += raw_bytes
        total_inline += inline_bytes

        audition_chunks.append(clean)
        audition_chunks.append(gap)

        key = f'audio/vo_{cid}.ogg'
        vo_assets.append({
            'key': key,
            'id': cid,
            'act': row['act'],
            'at': float(row['at']),
            'text': row['text'],
            'kind': 'audio_vo_ai',
            'file': f'opus/vo_{cid}.ogg',
            'mime': 'audio/ogg',
            'dur_s': round(dur, 3),
            'bytes': raw_bytes,
            'inline_bytes': inline_bytes,
            'sha256': sha256_file(c_ogg),
        })
        vo_cues.append({
            'id': cid,
            'act': row['act'],
            'at': float(row['at']),
            'dur_s': round(dur, 3),
            'key': key,
            'text': row['text'],
        })

    audition_all = np.concatenate(audition_chunks[:-1]) if audition_chunks else np.zeros(SR, dtype=np.float32)
    aud_wav = audio_out / 'vo_audition_all.wav'
    aud_ogg = audio_out / 'vo_audition_all.ogg'
    sf.write(aud_wav, audition_all, SR, subtype='PCM_24')
    encode_opus_mono(aud_wav, aud_ogg, bitrate='48k')

    m_path = audio_out / 'manifest.json'
    manifest = json.loads(m_path.read_text(encoding='utf-8')) if m_path.exists() else {'schemaVersion': 1, 'sampleRate': SR, 'assets': [], 'vo': []}
    manifest['assets'] = [a for a in manifest.get('assets', []) if a.get('kind') != 'audio_vo_ai'] + vo_assets
    manifest['vo'] = vo_cues
    manifest['voMeta'] = {
        'enabledByDefault': False,
        'aigc': True,
        'label': '导览配音（AI 合成 · 默认关闭）',
        'model': 'openbmb/VoxCPM2',
        'modelRevision': '7936080b41163874f38610f46f438e2c0757f9fd',
        'modelWeightsSha256': 'f7f964cfa9da23653baec6e6f7750719977ad944ed9f95fe52fe3a620506891d',
        'vocoder': 'AudioVAE V2 (audiovae.pth, 48kHz)',
        'vocoderWeightsSha256': '94b5d51e107e0507d4acc976cfdadb64edd6fd06d1f751dadbf2fd1594274bf1',
        'codePackage': 'voxcpm==2.0.3',
        'codeLicense': 'Apache-2.0',
        'modelAndVocoderLicense': 'Apache-2.0 (free for commercial use; AI-generated content disclosure required)',
        'voiceSource': 'Pure text --control voice design only; zero real human reference audio',
        'device': 'cpu',
        'totalSpeechDurS': round(total_dur, 3),
        'totalRawOpusBytes': total_raw_ogg,
        'totalInlineBase64Bytes': total_inline,
    }
    m_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    vo_report = {
        'cues': vo_assets,
        'totalSpeechDurS': round(total_dur, 3),
        'totalRawOpusBytes': total_raw_ogg,
        'totalInlineBase64Bytes': total_inline,
        'auditionWav': {'path': aud_wav.name, 'bytes': aud_wav.stat().st_size, 'sha256': sha256_file(aud_wav)},
        'auditionOpus': {'path': aud_ogg.name, 'bytes': aud_ogg.stat().st_size, 'sha256': sha256_file(aud_ogg)},
        'voxcpm2Manifest': vox_manifest,
        'meta': manifest['voMeta'],
    }
    (audio_out / 'vo-report.json').write_text(json.dumps(vo_report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({
        'cues': len(vo_assets),
        'totalSpeechDurS': round(total_dur, 3),
        'totalRawOpusBytes': total_raw_ogg,
        'totalInlineBase64Bytes': total_inline,
        'auditionOpusBytes': aud_ogg.stat().st_size,
    }, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
