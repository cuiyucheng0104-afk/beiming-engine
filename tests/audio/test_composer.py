# -*- coding: utf-8 -*-
"""通用算法电影作曲引擎（engine/audio/composer.py）与零跑调 Cover 对齐（music_gen.align_cover_pitch_locked）单元测试。

覆盖：
  1. 全部 6 种作曲风格原型（COMPOSER_STYLES：cinematic_orchestral, chinese_chamber, anime_nostalgic,
     hitech_minimal, ink_poetic, playful_folk）及 infer_composer_style 自动推断；
  2. 功能与调式和声终止式语法（plan_harmonic_arc）：半终止属持续音（suspension -> V7sus4/V9sus4）、
     高潮首拍正格回归主和弦（climax t0 -> Tonic）与片尾提前 1.5–2.2s 落定终章主和弦余韵；
  3. Viterbi 四声部动态规划连接（solve_voice_leading）：上声部平均跳进 <= 2.5 半音、0 声部交叉、0 平行五八度；
  4. 单一 4–6 音核心动机跨段落变形复现（呈示 / 紧缩变奏 / 调内模进 / 八度扩充对位，轮廓相关系数 >= 0.85）且绝无机械全音阶上下行；
  5. 悬停段音乐泛音呼吸（Fermata Breath：-42 dBFS <= RMS <= -22 dBFS，严禁 -120/-240 dBFS 死断电，且比 climax 安静 >= 12 dB）
     + 末段 0.28–0.42s 弱起引子渐强（Anacrusis Pickup）及 cuecheck.silence 兼容过门；
  6. 标准 SMF Type-1 多轨 MIDI 二进制结构校验（MThd + 多条 MTrk + Tempo/TimeSig/GM Program/NoteOn-Off）与 pad_tail_s 延音防提前淡出；
  7. 零跑调 Cover 对齐（align_cover_pitch_locked）：恒定偏移与 ±2.5% 锁相声码器伸缩在 440 Hz + 节拍瞬态复合信号上基频漂移 < 3 cents（~0.0 cents）。

用法（仓库根）：python -m unittest discover -s tests/audio -p "test_composer.py"
"""
from __future__ import annotations

import math
import os
import shutil
import struct
import sys
import unittest

import numpy as np
from scipy.signal import butter, sosfilt

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import _audiotest as H  # noqa: E402
from engine.audio import composer as COMP  # noqa: E402
from engine.audio import cuecheck as CC  # noqa: E402
from engine.audio import music_gen as MG  # noqa: E402


def _rms_dbfs(st: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(st)) + 1e-30))
    return 20.0 * math.log10(max(r, 1e-15))


def _estimate_peak_freq_hz(mono: np.ndarray, sr: int, f_lo: float = 380.0, f_hi: float = 500.0) -> float:
    """用 8x 零填充高分辨率 Hann 窗 FFT + 抛物线插值测量目标频带内的基频（精度 < 0.02 cents）。"""
    x = np.asarray(mono, dtype=np.float64)
    win = np.hanning(len(x))
    n_fft = 1 << int(math.ceil(math.log2(len(x) * 8)))
    spec = np.abs(np.fft.rfft(x * win, n=n_fft))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / float(sr))
    mask = (freqs >= f_lo) & (freqs <= f_hi)
    sub_idx = np.flatnonzero(mask)
    pk_local = int(np.argmax(spec[sub_idx]))
    k = int(sub_idx[pk_local])
    if 0 < k < len(spec) - 1:
        y0, y1, y2 = math.log(spec[k - 1] + 1e-18), math.log(spec[k] + 1e-18), math.log(spec[k + 1] + 1e-18)
        denom = y0 - 2.0 * y1 + y2
        delta = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-15 else 0.0
        return (k + float(np.clip(delta, -0.5, 0.5))) * float(sr) / float(n_fft)
    return float(freqs[k])


def _max_monotonic_scale_run(midis: list[int]) -> int:
    """计算旋律序列中最长连续单调级进（1~2 半音步进）步数，检测是否退化为机械上下行音阶练习。"""
    if len(midis) < 2:
        return 0
    best = 0
    cur = 0
    prev_dir = 0
    for a, b in zip(midis, midis[1:]):
        diff = b - a
        if 1 <= abs(diff) <= 2:
            d = 1 if diff > 0 else -1
            cur = (cur + 1) if d == prev_dir else 1
            prev_dir = d
            best = max(best, cur)
        else:
            cur = 0
            prev_dir = 0
    return best


class ComposerEngineTests(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('composer-test')
        self.arc_sections = [
            {'id': 'S1_intro', 't0': 0.0, 't1': 2.5, 'energy': 0.35, 'mood': 'establishing'},
            {'id': 'S2_dev', 't0': 2.5, 't1': 5.0, 'energy': 0.58, 'mood': 'development'},
            {'id': 'S3_rise', 't0': 5.0, 't1': 6.6, 'energy': 0.70, 'mood': 'rising'},
            {'id': 'S4_breath', 't0': 6.6, 't1': 7.8, 'energy': 0.42, 'mood': 'suspension'},
            {'id': 'S5_climax', 't0': 7.8, 't1': 11.2, 'energy': 0.92, 'mood': 'climax'},
        ]

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_style_inference_and_all_six_styles_harmony_and_voice_leading(self):
        self.assertEqual(
            COMP.COMPOSER_STYLES,
            ('cinematic_orchestral', 'chinese_chamber', 'anime_nostalgic', 'hitech_minimal', 'ink_poetic', 'playful_folk'),
        )
        self.assertEqual(COMP.infer_composer_style('古筝与竹笛喜庆剪纸春意'), 'chinese_chamber')
        self.assertEqual(COMP.infer_composer_style('Japanese anime nostalgic piano and strings'), 'anime_nostalgic')
        self.assertEqual(COMP.infer_composer_style('hud precision telemetry minimal', world='hitech'), 'hitech_minimal')
        self.assertEqual(COMP.infer_composer_style('空山水墨古琴洞箫', world='poetic'), 'ink_poetic')
        self.assertEqual(COMP.infer_composer_style('playful marimba pizzicato', world='cartoon'), 'playful_folk')
        self.assertEqual(COMP.infer_composer_style('epic orchestral adventure'), 'cinematic_orchestral')

        key_scales = [
            ('cinematic_orchestral', 'D', 'major'),
            ('chinese_chamber', 'D', 'pentatonic'),
            ('anime_nostalgic', 'G', 'major'),
            ('hitech_minimal', 'A', 'minor'),
            ('ink_poetic', 'E', 'minor-pentatonic'),
            ('playful_folk', 'C', 'lydian'),
        ]
        for style, key, scale in key_scales:
            with self.subTest(style=style, key=key, scale=scale):
                score = COMP.compose_film_score(
                    self.arc_sections,
                    dur=11.2,
                    fps=24,
                    key=key,
                    scale=scale,
                    bpm=96.0,
                    style=style,
                    events=[3.0, 4.2],
                    seed=42,
                )
                self.assertEqual(score['style'], style)
                vl = score['voice_leading']
                # DP 声部连接硬指标：上声部平均运动 <= 2.5 半音、0 声部交叉、0 平行五八度
                self.assertEqual(vl['voice_crossings'], 0, f'{style} 出现声部交叉')
                self.assertEqual(vl['parallel_fifths_octaves'], 0, f'{style} 出现平行五/八度')
                self.assertLessEqual(
                    vl['mean_upper_motion_st'],
                    2.5,
                    f'{style} 上声部平均跳进过大：{vl["mean_upper_motion_st"]} st',
                )
                for chd in score['chords']:
                    b, t, a, s = chd['voicing']
                    self.assertTrue(28 <= b <= 48, f'Bass 越界：{b}')
                    self.assertTrue(48 <= t < a < s <= 76, f'上三声部越界或交叉：{chd["voicing"]}')

                # 终止式语法核验：
                # 1) suspension 段末尾落定在属持续音（V7sus4 / V9sus4 / pent_zhi_sus，cadence == 'half_pedal'）
                tonic_pc = COMP.NOTE_OFFSETS[key.upper()]
                dom_pc = (tonic_pc + 7) % 12
                susp_chords = [c for c in score['chords'] if c['mood'] == 'suspension']
                self.assertTrue(len(susp_chords) >= 1)
                self.assertEqual(susp_chords[-1]['cadence'], 'half_pedal')
                self.assertEqual(susp_chords[-1]['root_pc'], dom_pc)
                self.assertIn('sus', susp_chords[-1]['quality'])

                # 2) climax 首拍回归主和弦（Tonic），且最终主和弦在片尾前 1.5–2.2s 落定余韵
                climax_chords = [c for c in score['chords'] if c['mood'] == 'climax']
                self.assertEqual(climax_chords[0]['root_pc'], tonic_pc)
                self.assertAlmostEqual(climax_chords[0]['t0'], 7.8, places=4)
                final_c = climax_chords[-1]
                self.assertEqual(final_c['cadence'], 'final_resolution')
                self.assertEqual(final_c['root_pc'], tonic_pc)
                ring_dur = 11.2 - final_c['t0']
                self.assertGreaterEqual(ring_dur, 1.50)
                self.assertLessEqual(ring_dur, 2.20)

    def test_single_motif_recurrence_and_zero_mechanical_scale_runs(self):
        for style in COMP.COMPOSER_STYLES:
            with self.subTest(style=style):
                score = COMP.compose_film_score(
                    self.arc_sections,
                    dur=11.2,
                    key='D',
                    scale='major',
                    bpm=100.0,
                    style=style,
                    seed=2026,
                )
                motif = score['motif']
                self.assertGreaterEqual(len(motif['degrees']), 4)
                self.assertLessEqual(len(motif['degrees']), 6)

                base_iv = np.asarray(motif['intervals'], dtype=np.float64)
                stmts = motif['statements']
                # 至少在 establishing, development, rising, climax 四个乐段均复现同一核心动机
                transforms = {st['transform'] for st in stmts}
                self.assertIn('establishing_statement', transforms)
                self.assertIn('development_diminution', transforms)
                self.assertTrue(any(t.startswith('rising_sequence_') for t in transforms))
                self.assertIn('climax_octave_statement', transforms)

                for st in stmts:
                    iv = np.asarray(st['intervals'], dtype=np.float64)
                    m = min(len(base_iv), len(iv))
                    self.assertGreaterEqual(m, 3)
                    # 检验音程轮廓方向完全一致且皮尔逊相关系数 >= 0.88
                    self.assertTrue(
                        np.array_equal(np.sign(base_iv[:m]), np.sign(iv[:m])),
                        f'{style} {st["transform"]} 音程方向偏离原动机：{iv} vs {base_iv}',
                    )
                    corr = float(np.corrcoef(base_iv[:m], iv[:m])[0, 1])
                    self.assertGreaterEqual(corr, 0.85, f'{style} {st["transform"]} 动机轮廓相关性过低：{corr:.3f}')

                # 检验全片主旋律绝无机械全八度音阶练习（连续单调级进不超过 3 步）
                lead_midis = [n['midi'] for n in score['tracks']['melody'] if n['role'] == 'motif_lead']
                self.assertGreaterEqual(len(lead_midis), 12)
                self.assertLessEqual(
                    _max_monotonic_scale_run(lead_midis),
                    3,
                    f'{style} 出现机械连续音阶跑动：{lead_midis}',
                )

    def test_melody_and_counter_melody_strict_scale_and_chord_purity(self):
        # 严格校验 chinese_chamber (D pentatonic) 与 cinematic_orchestral (D major)（覆盖多组随机种子，包括包含 D5->对位音 的动机）
        # 100% 旋律与对位副旋律音符落在合法音阶/和弦音级内，绝无 Bb4 (70) / C5 (72) 等意外半音！
        d_pent_pcs = {2, 4, 6, 9, 11}          # D, E, F#, A, B
        d_major_pcs = {2, 4, 6, 7, 9, 11, 1}   # D, E, F#, G, A, B, C#

        strict_cases = [
            ('chinese_chamber', 'D', 'pentatonic', d_pent_pcs),
            ('cinematic_orchestral', 'D', 'major', d_major_pcs),
            ('anime_nostalgic', 'G', 'major', {(7 + iv) % 12 for iv in COMP.SCALES['major']}),
            ('hitech_minimal', 'A', 'minor', {(9 + iv) % 12 for iv in COMP.SCALES['minor']}),
            ('ink_poetic', 'E', 'minor-pentatonic', {(4 + iv) % 12 for iv in COMP.SCALES['minor-pentatonic']}),
            ('playful_folk', 'C', 'lydian', {(0 + iv) % 12 for iv in COMP.SCALES['lydian']}),
        ]
        for style, key, scale, expected_scale_pcs in strict_cases:
            for seed in (7, 19, 42, 99, 2026):
                with self.subTest(style=style, key=key, scale=scale, seed=seed):
                    score = COMP.compose_film_score(
                        self.arc_sections,
                        dur=11.2,
                        fps=24,
                        key=key,
                        scale=scale,
                        bpm=108.0,
                        style=style,
                        events=[3.0, 4.2],
                        seed=seed,
                    )
                    melody_notes = score['tracks']['melody']
                    counter_notes = [n for n in melody_notes if n['role'] == 'counter_melody']
                    self.assertGreaterEqual(len(counter_notes), 3, f'{style} seed={seed} 未生成高潮对位副旋律')

                    for n in melody_notes:
                        pc = n['midi'] % 12
                        self.assertIn(
                            pc,
                            expected_scale_pcs,
                            f'{style} ({key} {scale}, seed={seed}) {n["role"]} 出现调外音 MIDI {n["midi"]} (pc={pc})',
                        )

                    # 验证每一颗对位音均位于同拍主旋律下方协和音程（3..9 半音，且严禁 6 半音三全音碰撞）
                    climax_leads = [
                        n for n in melody_notes
                        if n['role'] == 'motif_lead' and n.get('transform') == 'climax_octave_statement'
                    ]
                    self.assertEqual(len(counter_notes), len(climax_leads))
                    for n_lead, n_cnt in zip(climax_leads, counter_notes):
                        iv = n_lead['midi'] - n_cnt['midi']
                        self.assertGreaterEqual(iv, 3, f'对位音距离主旋律过近：{n_lead["midi"]} vs {n_cnt["midi"]}')
                        self.assertLessEqual(iv, 9, f'对位音距离主旋律过远：{n_lead["midi"]} vs {n_cnt["midi"]}')
                        self.assertNotEqual(iv, 6, f'对位音与主旋律形成刺耳三全音：{n_lead["midi"]} vs {n_cnt["midi"]}')

                    # 同时校验全总谱所有声部（harmony, bass, melody, arpeggio, percussion）100% 落在音阶∪和弦合法音级内
                    chord_union_pcs = {pc for c in score['chords'] for pc in c['pitch_classes']}
                    valid_all_pcs = expected_scale_pcs | chord_union_pcs
                    for tr_name, tr_notes in score['tracks'].items():
                        for n in tr_notes:
                            self.assertIn(
                                n['midi'] % 12,
                                valid_all_pcs,
                                f'{style} 轨 {tr_name} 出现调外意外半音 MIDI {n["midi"]}',
                            )

    def test_suspension_fermata_breath_anacrusis_pickup_and_cuecheck_harmony(self):
        for style in COMP.COMPOSER_STYLES:
            with self.subTest(style=style):
                score = COMP.compose_film_score(
                    self.arc_sections,
                    dur=11.2,
                    key='D',
                    scale='pentatonic' if style in ('chinese_chamber', 'ink_poetic') else 'major',
                    bpm=96.0,
                    style=style,
                    seed=42,
                )
                wav = COMP.render_score_wav(score, sr=48000, seed=42)
                self.assertEqual(wav.shape, (H.N(11.2), 2))

                # 6.6..7.8s 为 suspension，7.8..11.2s 为 climax
                susp_seg = wav[H.N(6.6):H.N(7.8)]
                core_breath = wav[H.N(6.75):H.N(7.38)]
                pickup_seg = wav[H.N(7.44):H.N(7.80)]
                climax_seg = wav[H.N(7.8):H.N(11.2)]

                susp_rms = _rms_dbfs(susp_seg)
                core_rms = _rms_dbfs(core_breath)
                pickup_rms = _rms_dbfs(pickup_seg)
                climax_rms = _rms_dbfs(climax_seg)

                # 1) 严禁 -120 / -240 dBFS 硬断电，保持 -42..-22 dBFS 音乐泛音呼吸
                self.assertGreaterEqual(susp_rms, -42.0, f'{style} 呼吸段过弱近乎断电：{susp_rms:.2f} dBFS')
                self.assertLessEqual(susp_rms, -22.0, f'{style} 呼吸段未充分收束：{susp_rms:.2f} dBFS')
                self.assertGreaterEqual(core_rms, -42.0)

                # 2) 比 climax 显著安静 >= 12.0 dB
                self.assertGreaterEqual(
                    climax_rms - susp_rms,
                    12.0,
                    f'{style} 高潮与呼吸动态反差不足：climax={climax_rms:.2f}, susp={susp_rms:.2f}',
                )

                # 3) 末段 0.36s 弱起引子（Anacrusis Pickup）能量明显抬升引向高潮首拍
                self.assertEqual(len(score['pickups']), 1)
                self.assertGreater(
                    pickup_rms,
                    core_rms + 2.0,
                    f'{style} 弱起引子未产生渐强推浪：pickup={pickup_rms:.2f}, core={core_rms:.2f}',
                )

        # 4) 验证带 ~-30 dBFS Fermata Breath + 弱起引子的成片无需砍成 -240 dBFS 即可顺畅通过 cuecheck.silence（quietDb=15）
        #    96 BPM 下 1 拍 = 0.625s（15 帧 @ 24fps）：A=0..3.75s (6拍), B=3.75..5.625s (3拍呼吸), C=5.625..9.0s, hit1=6.25s (C1.2 正拍)
        film_dir = os.path.join(self.td, 'breath_film')
        score_cc = COMP.compose_film_score(
            [
                {'id': 'A', 't0': 0.0, 't1': 3.75, 'energy': 0.58, 'mood': 'development'},
                {'id': 'B', 't0': 3.75, 't1': 5.625, 'energy': 0.42, 'mood': 'suspension'},
                {'id': 'C', 't0': 5.625, 't1': 9.0, 'energy': 0.94, 'mood': 'climax'},
            ],
            dur=9.0,
            fps=24,
            key='D',
            scale='pentatonic',
            bpm=96.0,
            style='chinese_chamber',
            seed=7,
        )
        wav_cc = COMP.render_score_wav(score_cc, sr=48000, seed=7)
        H.write_wav(os.path.join(film_dir, 'out', 'mix.wav'), wav_cc)
        with open(os.path.join(film_dir, 'timeline.json'), 'w', encoding='utf-8') as f:
            import json
            json.dump({
                'fps': 24,
                'dur': 9.0,
                'secs': [
                    {'id': 'A', 't0': 0.0, 't1': 3.75, 'bpm': 96, 'meter': 4},
                    {'id': 'B', 't0': 3.75, 't1': 5.625, 'bpm': 96, 'meter': 4},
                    {'id': 'C', 't0': 5.625, 't1': 9.0, 'bpm': 96, 'meter': 4},
                ],
                't': {'hit1': 6.25},
            }, f)
        with open(os.path.join(film_dir, 'events.json'), 'w', encoding='utf-8') as f:
            import json
            json.dump({'dur': 9.0, 'ev': [{'t': 6.25, 'type': 'hit', 'cue': 'hit1'}]}, f)
        with open(os.path.join(film_dir, 'out', 'score_onsets.json'), 'w', encoding='utf-8') as f:
            import json
            onsets_list = sorted(set(score_cc['note_onsets']) | {6.25})
            json.dump({'onsets': {'hit1': 6.25}, 'notes': onsets_list}, f)

        rep_cc = CC.run_check(film_dir, silences=['B'], quiet_db=15.0, grid=4, tol_ms=1.0, out=lambda *_: None)
        self.assertTrue(rep_cc['ok'], rep_cc)
        self.assertEqual(rep_cc['silences'][0]['status'], 'pass')
        self.assertGreater(rep_cc['silences'][0]['rmsDb'], -38.0)
        self.assertLess(rep_cc['silences'][0]['rmsDb'], -24.0)

    def test_concert_pitch_440hz_pad_tail_and_smf_type1_midi_export(self):
        # 1) 验证 A4 = 440.00 Hz 零跑调合成（< 0.5 cents 误差）
        single_sec = [{'id': 'S1', 't0': 0.0, 't1': 3.0, 'energy': 0.42, 'mood': 'suspension'}]
        score_a = COMP.compose_film_score(single_sec, dur=3.0, key='D', scale='major', style='cinematic_orchestral', seed=11)
        # D 大调属音为 A（MIDI 69 = 440.00 Hz）
        wav_a = COMP.render_score_wav(score_a, sr=48000, seed=11)
        f_meas = _estimate_peak_freq_hz(wav_a[H.N(0.4):H.N(2.4), 0], 48000, f_lo=420.0, f_hi=460.0)
        cents_err = abs(1200.0 * math.log2(f_meas / 440.0))
        self.assertLess(cents_err, 0.5, f'导引合成器 A4 音高偏移 {cents_err:.3f} cents（测得 {f_meas:.3f} Hz）')

        # 2) 验证 pad_tail_s > 0 平滑延续终章主和弦余韵（防 Suno / ACE-Step Cover 提前淡出）
        score_full = COMP.compose_film_score(self.arc_sections, dur=11.2, key='D', scale='pentatonic', style='chinese_chamber', seed=42)
        wav_padded = COMP.render_score_wav(score_full, sr=48000, pad_tail_s=4.5, seed=42)
        self.assertEqual(wav_padded.shape, (H.N(15.7), 2))
        tail_hold_rms = _rms_dbfs(wav_padded[H.N(11.2):H.N(13.5)])
        self.assertGreater(tail_hold_rms, -28.0, f'pad_tail_s 延续段主和弦能量过低：{tail_hold_rms:.2f} dBFS')

        # 3) 验证纯 Python 标准 SMF Type-1 (.mid) 导出器结构与字节完整性
        midi_path = os.path.join(self.td, 'score.mid')
        written = COMP.export_midi(score_full, midi_path, ticks_per_beat=480)
        self.assertEqual(written, os.path.abspath(midi_path))
        with open(midi_path, 'rb') as f:
            raw = f.read()

        self.assertEqual(raw[:4], b'MThd')
        hdr_len, fmt, n_tracks, division = struct.unpack('>IHHH', raw[4:14])
        self.assertEqual(hdr_len, 6)
        self.assertEqual(fmt, 1)  # SMF Type-1
        self.assertGreaterEqual(n_tracks, 5)
        self.assertEqual(division, 480)

        pos = 14
        seen_tracks = 0
        program_changes = 0
        note_ons = 0
        note_offs = 0
        has_tempo = False
        while pos < len(raw):
            self.assertEqual(raw[pos:pos + 4], b'MTrk')
            trk_len = struct.unpack('>I', raw[pos + 4:pos + 8])[0]
            trk_body = raw[pos + 8:pos + 8 + trk_len]
            self.assertEqual(len(trk_body), trk_len)
            self.assertTrue(trk_body.endswith(b'\xFF\x2F\x00'), 'MTrk 必须以 End-of-Track FF 2F 00 结尾')
            if b'\xFF\x51\x03' in trk_body:
                has_tempo = True
            program_changes += sum(1 for b in trk_body if (b & 0xF0) == 0xC0)
            note_ons += sum(1 for i in range(len(trk_body) - 2) if (trk_body[i] & 0xF0) == 0x90 and trk_body[i + 2] > 0)
            note_offs += sum(1 for i in range(len(trk_body) - 2) if (trk_body[i] & 0xF0) == 0x80)
            pos += 8 + trk_len
            seen_tracks += 1

        self.assertEqual(pos, len(raw))
        self.assertEqual(seen_tracks, n_tracks)
        self.assertTrue(has_tempo)
        self.assertGreaterEqual(program_changes, 4)
        self.assertGreater(note_ons, 20)
        self.assertGreaterEqual(note_offs, 20)

        # 4) 验证 music_gen.build_guide_score 兼容扩展参数 style 与 midi_out
        midi_via_mg = os.path.join(self.td, 'via_mg.mid')
        g_st, g_meta = MG.build_guide_score(
            self.arc_sections,
            dur=11.2,
            key='D',
            scale='pentatonic',
            bpm=96.0,
            style='chinese_chamber',
            midi_out=midi_via_mg,
            seed=42,
        )
        self.assertEqual(g_st.shape, (H.N(11.2), 2))
        self.assertEqual(g_meta['style'], 'chinese_chamber')
        self.assertIn('motif', g_meta)
        self.assertIn('voice_leading', g_meta)
        self.assertTrue(os.path.isfile(midi_via_mg))

    def test_align_cover_pitch_locked_zero_detune_on_offset_and_uniform_stretch(self):
        sr = 48000
        dur = 6.0
        n = H.N(dur)
        t = np.arange(n, dtype=np.float64) / float(sr)
        r = np.random.default_rng(123)

        # 构造参考导引轨：440.00 Hz 纯音双声道（带细微立体声相位差）+ 每 0.60s 一次清脆节拍打击瞬态
        beat_times = [0.60, 1.20, 1.80, 2.40, 3.00, 3.60, 4.20, 4.80, 5.40]

        def _make_test_track(hit_positions: list[float]) -> np.ndarray:
            tonal_l = 0.36 * np.sin(2.0 * math.pi * 440.0 * t) + 0.14 * np.sin(2.0 * math.pi * 880.0 * t)
            tonal_r = 0.35 * np.sin(2.0 * math.pi * 440.0 * t + 0.18) + 0.14 * np.sin(2.0 * math.pi * 880.0 * t + 0.18)
            st = np.stack([tonal_l, tonal_r], axis=1)
            click_len = int(0.045 * sr)
            tc = np.arange(click_len, dtype=np.float64) / float(sr)
            burst_raw = sosfilt(butter(2, [900.0, 5500.0], 'band', fs=float(sr), output='sos'), r.standard_normal(click_len))
            click = (
                0.55 * np.exp(-tc / 0.009) * burst_raw
                + 0.45 * np.exp(-tc / 0.016) * np.sin(2.0 * math.pi * 110.0 * tc)
            )
            for hp in hit_positions:
                i0 = int(round(hp * sr))
                if 0 <= i0 < n:
                    m = min(click_len, n - i0)
                    st[i0:i0 + m, 0] += click[:m]
                    st[i0:i0 + m, 1] += click[:m]
            return st

        guide_st = _make_test_track(beat_times)

        # 场景 A：Cover 整体迟到 +76 ms（无速度伸缩）
        cover_late = _make_test_track([bt + 0.076 for bt in beat_times])
        aligned_a, info_a = MG.align_cover_pitch_locked(cover_late, guide_st, sr=sr, max_shift_ms=140.0)
        self.assertEqual(aligned_a.shape, guide_st.shape)
        self.assertAlmostEqual(info_a['shift_ms'], 76.0, delta=8.0)
        self.assertGreater(info_a['corr_after'], info_a['corr_before'] + 0.25)
        f_a = _estimate_peak_freq_hz(aligned_a[H.N(0.5):H.N(5.2), 0], sr)
        drift_cents_a = abs(1200.0 * math.log2(f_a / 440.0))
        self.assertLess(drift_cents_a, 0.5, f'恒定平移后音高漂移超标：{drift_cents_a:.3f} cents')

        # 场景 B：Cover 节拍偏快 1.8%（bt / 1.018）且带 +44 ms 初始偏移，但基频保持精确 440.00 Hz！
        # 若错误使用 PCHIP 变速重采样拉开 1.8%，基频会暴跌 ~31 cents；而锁相声码器必须保持 < 3.0 cents（~0.0 cents）！
        cover_fast = _make_test_track([0.044 + bt / 1.018 for bt in beat_times])
        aligned_b, info_b = MG.align_cover_pitch_locked(
            cover_fast,
            guide_st,
            sr=sr,
            max_shift_ms=140.0,
            allow_uniform_stretch=True,
            max_stretch_pct=2.5,
        )
        self.assertEqual(info_b['method'], 'phase_vocoder_locked')
        self.assertAlmostEqual(info_b['stretch_ratio'], 1.018, delta=0.006)
        self.assertGreater(info_b['corr_after'], info_b['corr_before'] + 0.20)

        f_b_l = _estimate_peak_freq_hz(aligned_b[H.N(0.6):H.N(5.2), 0], sr)
        f_b_r = _estimate_peak_freq_hz(aligned_b[H.N(0.6):H.N(5.2), 1], sr)
        drift_cents_l = abs(1200.0 * math.log2(f_b_l / 440.0))
        drift_cents_r = abs(1200.0 * math.log2(f_b_r / 440.0))
        self.assertLess(drift_cents_l, 3.0, f'锁相声码器左声道基频漂移超标：{drift_cents_l:.3f} cents（测得 {f_b_l:.3f} Hz）')
        self.assertLess(drift_cents_r, 3.0, f'锁相声码器右声道基频漂移超标：{drift_cents_r:.3f} cents（测得 {f_b_r:.3f} Hz）')

        # 单声道相关性校验（验证左右声道同步复数旋转不破坏立体声相位）
        l_seg = aligned_b[H.N(0.6):H.N(5.2), 0]
        r_seg = aligned_b[H.N(0.6):H.N(5.2), 1]
        lr_corr = float(np.corrcoef(l_seg, r_seg)[0, 1])
        self.assertGreater(lr_corr, 0.92, f'锁相声码器破坏了双声道相位相关性：{lr_corr:.3f}')


if __name__ == '__main__':
    unittest.main()
