# -*- coding: utf-8 -*-
"""四干线对白融合（VO + Music + Amb + FX/Foley）、视觉角色轨迹绑定（bind_actor）、
对白清晰度门禁（audio.dialogue）与长片流式粘合母带（stream.bus_glue_compress / stream.master_chain）单元测试。"""
import json
import os
import shutil
import tracemalloc
import unittest

import numpy as np

import _audiotest as H
from engine.audio import cues as C
from engine.audio import director as DR
from engine.audio import dsp as D
from engine.audio import editorial as ED
from engine.audio import meter as M
from engine.audio import mixing as MX
from engine.audio import qa as QA
from engine.audio import stream as S
from engine.audio.voice import dialogue as DL


def _band_rms_db(st: np.ndarray, lo: float, hi: float, sr: int = D.SR) -> float:
    mono = st.mean(axis=1) if st.ndim == 2 else st
    win = np.hanning(len(mono))
    sp = np.abs(np.fft.rfft(mono * win)) ** 2
    fq = np.fft.rfftfreq(len(mono), 1.0 / float(sr))
    m = (fq >= lo) & (fq <= hi)
    return 10.0 * np.log10(float(sp[m].sum()) / max(1, len(mono)) + 1e-24)


def _synth_articulate_vo(dur: float, spans: list, seed: int = 19) -> np.ndarray:
    """生成带基频谐波、共振峰（900/2200/3100 Hz）与清辅音齿擦的模拟对白轨，句间严格静音 0.0。"""
    r = D.rng(seed)
    n = D.N(dur)
    out = np.zeros((n, 2), dtype=float)
    for idx, (t0, t1) in enumerate(spans):
        s0, s1 = D.N(t0), min(n, D.N(t1))
        m = s1 - s0
        if m <= 64:
            continue
        tt = np.arange(m, dtype=float) / float(D.SR)
        f0 = 155.0 + 22.0 * (idx % 2) + 12.0 * np.sin(2.0 * np.pi * 2.4 * tt)
        ph = 2.0 * np.pi * np.cumsum(f0) / float(D.SR)
        harm = np.zeros(m, dtype=float)
        for h in range(1, 24):
            fh = float(np.mean(f0)) * h
            formant_w = (
                1.0 * np.exp(-((fh - 520.0) / 180.0) ** 2)
                + 0.85 * np.exp(-((fh - 1850.0) / 380.0) ** 2)
                + 0.65 * np.exp(-((fh - 3050.0) / 520.0) ** 2)
            )
            harm += (0.12 + formant_w) * np.sin(h * ph) / (h ** 0.55)
        consonants = D.bp(r.standard_normal(m), 1800.0, 5200.0, 2) * (0.18 + 0.16 * np.abs(np.sin(2.0 * np.pi * 4.5 * tt)))
        syl_env = 0.65 + 0.35 * np.sin(2.0 * np.pi * 4.2 * tt)
        line = D.fade((harm + consonants) * syl_env * 0.16, 0.012, 0.025)
        line[0] = line[-1] = 0.0
        out[s0:s1] = D.stereo(line, 0.0)
    return out


class VoFourStemAndStreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('vo-fourstem-stream')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_sculpt_stem_eq_vo_and_carve_dialogue_pocket_preserve_bass_and_air(self):
        """验证 sculpt_stem_eq 对 vo/dialogue 的四段塑形与句间严格 0.0，以及 carve_dialogue_pocket 100% 守护 <350Hz 低频。"""
        r = D.rng(101)
        dur = 5.0
        n = D.N(dur)

        # 1) sculpt_stem_eq: 85Hz HPF, -1.8dB@240Hz, +1.2dB@3kHz, -1.0dB@7.2kHz，且句间静音段保持严格 0.0
        vo_in = np.zeros((n, 2), dtype=float)
        seg_noise = D.fade(D.stereo(r.standard_normal(D.N(1.6)) * 0.20, 0.0), 0.01, 0.02)
        vo_in[D.N(0.6):D.N(2.2)] = seg_noise
        vo_in[D.N(3.0):D.N(4.6)] = seg_noise

        eq_out = ED.sculpt_stem_eq({'vo': vo_in, 'dialogue': vo_in})
        for key in ('vo', 'dialogue'):
            st = eq_out[key]
            self.assertEqual(float(np.max(np.abs(st[:D.N(0.6)]))), 0.0, f'{key} 前导静音隙必须严格为 0.0')
            self.assertEqual(float(np.max(np.abs(st[D.N(2.2):D.N(3.0)]))), 0.0, f'{key} 句间静音隙必须严格为 0.0')
            self.assertEqual(float(np.max(np.abs(st[D.N(4.6):]))), 0.0, f'{key} 尾段静音隙必须严格为 0.0')

            act_before = vo_in[D.N(0.7):D.N(2.1)]
            act_after = st[D.N(0.7):D.N(2.1)]
            sub_diff = _band_rms_db(act_after, 25.0, 60.0) - _band_rms_db(act_before, 25.0, 60.0)
            boom_diff = _band_rms_db(act_after, 200.0, 285.0) - _band_rms_db(act_before, 200.0, 285.0)
            cons_diff = _band_rms_db(act_after, 2500.0, 3600.0) - _band_rms_db(act_before, 2500.0, 3600.0)
            sib_diff = _band_rms_db(act_after, 6600.0, 7900.0) - _band_rms_db(act_before, 6600.0, 7900.0)
            self.assertLess(sub_diff, -5.0)
            self.assertLess(boom_diff, -1.0)
            self.assertGreater(cons_diff, 0.7)
            self.assertLess(sib_diff, -0.4)

        # 2) carve_dialogue_pocket: <350Hz 大提琴低音 0.0 dB 不动，>6500Hz 空气 <= 0.5 dB，仅挖 800–4200Hz 共振峰带
        white_st = D.stereo(r.standard_normal(n) * 0.18, 0.0)
        fx_sparse = np.zeros((n, 2), dtype=float)
        fx_sparse[D.N(1.0):D.N(1.8)] = white_st[D.N(1.0):D.N(1.8)]
        vo_line = _synth_articulate_vo(dur, [(0.8, 2.6)], seed=7)
        pocketed = ED.carve_dialogue_pocket(
            {'music': white_st, 'amb': white_st, 'fx': fx_sparse, 'foley': fx_sparse},
            vo_line,
            spans=[(0.8, 2.6)],
            formant_duck_db=4.2,
            amb_duck_db=2.5,
            fx_duck_db=1.8,
        )

        sp_slice = slice(D.N(1.0), D.N(2.4))
        sil_slice = slice(D.N(3.4), D.N(4.7))
        mus_bass_drop = _band_rms_db(pocketed['music'][sp_slice], 55.0, 340.0) - _band_rms_db(white_st[sp_slice], 55.0, 340.0)
        mus_formant_drop = _band_rms_db(pocketed['music'][sp_slice], 1000.0, 3800.0) - _band_rms_db(white_st[sp_slice], 1000.0, 3800.0)
        mus_air_drop = _band_rms_db(pocketed['music'][sp_slice], 6800.0, 14000.0) - _band_rms_db(white_st[sp_slice], 6800.0, 14000.0)
        mus_after_rel = _band_rms_db(pocketed['music'][sil_slice], 1000.0, 3800.0) - _band_rms_db(white_st[sil_slice], 1000.0, 3800.0)

        self.assertGreater(mus_bass_drop, -0.05, f'配乐 <350 Hz 温暖底盘被误伤：{mus_bass_drop:.4f} dB')
        self.assertLess(mus_bass_drop, 0.05)
        self.assertLess(mus_formant_drop, -3.2, f'配乐 800-4200 Hz 共振峰带未充分让位：{mus_formant_drop:.2f} dB')
        self.assertGreater(mus_formant_drop, -4.6)
        self.assertGreater(mus_air_drop, -0.5, f'配乐 >6500 Hz 空气泛音衰减超 0.5 dB：{mus_air_drop:.3f} dB')
        self.assertGreater(mus_after_rel, -0.05, '台词结束后配乐共振峰带必须完全恢复')

        amb_drop = _band_rms_db(pocketed['amb'][sp_slice], 800.0, 4000.0) - _band_rms_db(white_st[sp_slice], 800.0, 4000.0)
        fx_drop = _band_rms_db(pocketed['fx'][D.N(1.1):D.N(1.7)], 1400.0, 3800.0) - _band_rms_db(fx_sparse[D.N(1.1):D.N(1.7)], 1400.0, 3800.0)
        self.assertLess(amb_drop, -1.8)
        self.assertLess(fx_drop, -1.2)
        self.assertEqual(float(np.max(np.abs(pocketed['fx'][D.N(2.5):]))), 0.0, 'fx 静音区间应保持 0.0')

    def test_four_stem_workstation_dialogue_fusion_bass_warmth_and_qa_pass(self):
        """验证 FourStemWorkstation 四干线协同（VO + Music + Amb + FX/Foley）：
        导出 stems['vo']，配乐 <350Hz 低频在对白期间衰减少于 0.6 dB，1–4kHz 清晰度 ≥ +3.5 dB，且 audio.dialogue PASS。"""
        self.assertIs(ED.FourStemWorkstation, ED.ThreeStemWorkstation)
        dur = 8.0
        fps = 24
        nf = int(dur * fps)
        n = D.N(dur)
        t = D.T(dur)
        r = D.rng(202)

        fdir = os.path.join(self.td, 'fourstem-film')
        H.film_json(
            fdir,
            frames=nf,
            fps=fps,
            cuts=(96,),
            audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.5},
        )
        dlg_doc = {
            'schema': DL.SCHEMA,
            'speakers': {'narrator': {'provider': 'synthetic', 'voice': 'narrator'}},
            'lines': [
                {'id': 'L1', 'speaker': 'narrator', 'text': '北冥有鱼，其名为鲲。', 'at': 24},
                {'id': 'L2', 'speaker': 'narrator', 'text': '化而为鸟，其名为鹏。', 'at': 120},
            ],
        }
        dlg_path = os.path.join(fdir, 'dialogue.json')
        with open(dlg_path, 'w', encoding='utf-8') as f:
            json.dump(dlg_doc, f, ensure_ascii=False, indent=1)
        dlg_res = DL.build(fdir, film=fdir, out=os.path.join(fdir, 'out', 'dialogue'), log=lambda *_: None)

        # 稳态大提琴双音底盘（110Hz + 165Hz + 220Hz）+ 厚实中频弦乐 + 高频泛音空气层
        cello_bass = (
            0.34 * np.sin(2.0 * np.pi * 110.0 * t)
            + 0.26 * np.sin(2.0 * np.pi * 164.81 * t)
            + 0.20 * np.sin(2.0 * np.pi * 220.0 * t)
        )
        strings_mid = D.bp(D.pink(n, r), 450.0, 5200.0, 2) * 0.36
        air_shimmer = D.bp(D.white(n, r), 6800.0, 12500.0, 2) * 0.05
        music_score = D.stereo(cello_bass + strings_mid + air_shimmer, 0.0)
        amb_bed = D.decor_pair(D.pink, D.N(4.5), r, corr=0.55) * 0.14
        step_foley = 0.55 * np.exp(-D.T(0.11) / 0.025) * D.bp(D.pink(D.N(0.11), r), 220.0, 4200.0, 2)
        accent_fx = 0.75 * np.exp(-D.T(0.26) / 0.065) * D.bp(D.pink(D.N(0.26), r), 140.0, 5600.0, 2)

        ws = ED.FourStemWorkstation(dur, fps=fps, world='realistic', target_lufs=-14.0, max_tp=-1.5)
        ws.set_scenes(
            [
                {'in_s': 0.0, 'out_s': 4.0, 'wave': amb_bed, 'transition': 'hard_cut'},
                {'in_s': 4.0, 'out_s': 8.0, 'wave': amb_bed * 0.9, 'transition': 'hard_cut'},
            ],
            target_lufs=-29.5,
        )
        ws.set_music(music_score, key='A', target_lufs=-18.0)
        ws.add_foley_series('walk', [1.2, 1.7, 5.2, 5.7], takes=[step_foley], target_lufs=-23.5, seed=11)
        ws.add_sfx('staff_tap', accent_fx, 3.85, anchor=0.0, role='support', bus='fx', target_lufs=-19.5)
        ws.set_dialogue(
            dlg_res['paths']['voice'],
            voice_json=dlg_res['paths']['manifest'],
            target_lufs=-16.0,
            formant_duck_db=4.2,
            amb_duck_db=2.5,
            fx_duck_db=1.8,
        )

        master_st, stems, rep = ws.mixdown()
        self.assertIn('vo', stems)
        self.assertEqual(stems['vo'].shape, (n, 2))
        self.assertEqual(float(np.max(np.abs(stems['vo'][0]))), 0.0)
        self.assertEqual(float(np.max(np.abs(stems['vo'][-1]))), 0.0)

        # 验证配乐 <350 Hz 温暖底盘在对白有声期相对非对白期衰减 < 0.6 dB
        sp_spans = DL.spans(dlg_res['paths']['manifest'])
        s0_a, s0_b = D.N(sp_spans[0][0] + 0.15), D.N(sp_spans[0][1] - 0.15)
        gap_a, gap_b = D.N(sp_spans[0][1] + 0.35), D.N(sp_spans[1][0] - 0.25)
        bass_speech_db = _band_rms_db(stems['music'][s0_a:s0_b], 60.0, 340.0)
        bass_gap_db = _band_rms_db(stems['music'][gap_a:gap_b], 60.0, 340.0)
        bass_drop_db = bass_gap_db - bass_speech_db
        self.assertLess(abs(bass_drop_db), 0.6, f'配乐 <350 Hz 大提琴低频在对白期发生抽吸：{bass_drop_db:+.3f} dB')

        # 落盘跑真实 engine.audio.qa（含 audio.dialogue 门禁）
        wav_path = C.write(os.path.join(fdir, 'out'), master_st, stems=stems)
        checks, _ = QA.analyze(
            wav_path,
            fps=fps,
            frames=nf,
            cuts=(96,),
            target_lufs=-14.0,
            tol_lu=0.5,
            max_tp=-1.5,
            loudness_at='mix',
            film={'fps': fps, 'events': [], 'audio': {}, 'dir': fdir, 'cuts': (96,)},
        )
        by_id = {c['id']: c for c in checks}
        self.assertIn('audio.dialogue', by_id)
        dlg_chk = by_id['audio.dialogue']
        self.assertEqual(dlg_chk['status'], 'pass', dlg_chk)
        self.assertGreaterEqual(dlg_chk['evidence']['snr1k4kDb'], 3.5, dlg_chk)
        self.assertIsNotNone(rep['dialogueSnr1k4kDb'])

        cli_r = H.run(['python', '-m', 'engine.audio.qa', '--film', fdir, '--fail-on-warn', '--json'])
        self.assertEqual(cli_r.returncode, 0, cli_r.stdout + '\n' + cli_r.stderr)

    def test_qa_dialogue_gate_fail_warn_and_silent_omission(self):
        """验证 qa.py audio.dialogue：伴奏淹没对白 (< -2 dB) 报硬失败退出 4，[-2, +2) dB 报 dialogue_masked 告警，无对白不产出。"""
        dur = 6.0
        fps = 24
        nf = int(dur * fps)
        n = D.N(dur)
        vo_raw = _synth_articulate_vo(dur, [(0.8, 2.6), (3.4, 5.1)], seed=33)
        vo_clean = vo_raw * (0.12 / D.rms(vo_raw[D.N(0.8):D.N(2.6)]))
        mus_base = H.mastered(dur, lufs=-16.0, tp=-1.5, seed=45)

        def _make_case(case_name: str, vo_gain: float, mus_gain: float, clip_vo: bool = False):
            d = os.path.join(self.td, case_name)
            H.film_json(
                d,
                frames=nf,
                fps=fps,
                cuts=(),
                audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.0},
            )
            vo_s = vo_clean * vo_gain
            mus_s = mus_base * mus_gain
            mix_st, g_m, _ = MX.loudness_to(D.fade(vo_s + mus_s, 0.02, 0.04), -14.0, -1.2)
            mix_st[0] = mix_st[-1] = 0.0
            sc = float(D.undb(g_m))
            vo_out = vo_s * sc
            if clip_vo:
                vo_out[D.N(1.2):D.N(1.2) + 8] = 1.0
            H.write_wav(os.path.join(d, 'out', 'stems', 'vo.wav'), vo_out, subtype='FLOAT' if clip_vo else 'PCM_24')
            H.write_wav(os.path.join(d, 'out', 'stems', 'music.wav'), mus_s * sc)
            H.write_wav(os.path.join(d, 'out', 'mix.wav'), mix_st)
            return d

        # 1) 伴奏淹没对白（1–4 kHz SNR < -2.0 dB）→ FAIL（退出码 4）
        d_fail = _make_case('dlg-fail-drowned', vo_gain=0.42, mus_gain=1.15)
        r_fail = H.run(['python', '-m', 'engine.audio.qa', '--film', d_fail, '--json'])
        env_fail = H.envelope(r_fail)
        self.assertEqual(r_fail.returncode, 4, env_fail)
        self.assertIn('audio.dialogue', env_fail['data']['summary']['hardFailures'])
        rep_fail = H.read_json(os.path.join(d_fail, 'out', 'mix.qa.json'))
        c_fail = next(c for c in rep_fail['checks'] if c['id'] == 'audio.dialogue')
        self.assertEqual((c_fail['status'], c_fail['severity']), ('fail', 'hard'))
        self.assertLess(c_fail['evidence']['snr1k4kDb'], -2.0)

        # 2) 1–4 kHz SNR 落在 [-2.0, +2.0) dB 临界掩蔽区 → WARN（默认退出 0，--fail-on-warn 退出 4）
        d_warn = _make_case('dlg-warn-masked', vo_gain=0.65, mus_gain=1.00)
        r_warn = H.run(['python', '-m', 'engine.audio.qa', '--film', d_warn, '--json'])
        self.assertEqual(r_warn.returncode, 0, r_warn.stdout + r_warn.stderr)
        rep_warn = H.read_json(os.path.join(d_warn, 'out', 'mix.qa.json'))
        c_warn = next(c for c in rep_warn['checks'] if c['id'] == 'audio.dialogue')
        self.assertEqual((c_warn['status'], c_warn['severity']), ('warn', 'soft'), c_warn)
        self.assertGreaterEqual(c_warn['evidence']['snr1k4kDb'], -2.0)
        self.assertLess(c_warn['evidence']['snr1k4kDb'], 2.0)
        self.assertIn('dialogue_masked', c_warn['message'])
        r_warn_strict = H.run(['python', '-m', 'engine.audio.qa', '--film', d_warn, '--fail-on-warn', '--no-report', '--json'])
        self.assertEqual(r_warn_strict.returncode, 4)

        # 3) 对白分轨样本满幅削波（>= 0.99999）→ FAIL
        d_clip = _make_case('dlg-fail-clip', vo_gain=1.20, mus_gain=0.60, clip_vo=True)
        r_clip = H.run(['python', '-m', 'engine.audio.qa', '--film', d_clip, '--no-report', '--json'])
        self.assertEqual(r_clip.returncode, 4)
        self.assertIn('audio.dialogue', H.envelope(r_clip)['data']['summary']['hardFailures'])

        # 4) 全静音 vo.wav 不应产出 audio.dialogue 检查项
        d_sil = os.path.join(self.td, 'dlg-silent')
        H.film_json(d_sil, frames=nf, fps=fps, cuts=())
        mix_inst = H.mastered(dur, lufs=-14.0, tp=-1.5, seed=8)
        H.write_wav(os.path.join(d_sil, 'out', 'stems', 'vo.wav'), np.zeros((n, 2)))
        H.write_wav(os.path.join(d_sil, 'out', 'stems', 'music.wav'), mix_inst)
        H.write_wav(os.path.join(d_sil, 'out', 'mix.wav'), mix_inst)
        checks_sil, _ = QA.analyze(os.path.join(d_sil, 'out', 'mix.wav'), fps=fps, frames=nf, target_lufs=-14.0)
        self.assertNotIn('audio.dialogue', {c['id'] for c in checks_sil})

    def test_bind_actor_visual_telemetry_pan_and_scale_rise(self):
        """验证 bind_actor：角色从左 (-0.8) 移向右 (+0.8) 且画面占比从 0.06 增至 0.55 时，实现左→右声像迁移且近景增益高出远景 > +8 dB。"""
        dur = 4.0
        fps = 24
        nf = int(dur * fps)
        r = D.rng(55)

        # 角色在 [0.25s .. 3.50s]（第 6..84 帧）可见，横向从 -0.80 扫至 +0.80，视觉尺度从 0.06 逼近至 0.55
        vis = [1.0 if 6 <= f < 84 else 0.0 for f in range(nf)]
        xs = [float(np.interp(f, [6, 83], [-0.80, +0.80])) if 6 <= f < 84 else 0.0 for f in range(nf)]
        scales = [float(np.interp(f, [6, 83], [0.06, 0.55])) if 6 <= f < 84 else 0.0 for f in range(nf)]
        kin = C.Kinematics({
            'fps': fps,
            'dur': dur,
            'tracks': {'hovercraft': {'x': xs, 'scale': scales, 'visible': vis}},
        })

        engine_tex = D.bp(D.pink(D.N(1.1), r), 180.0, 4800.0, 2) * 0.42
        ws = ED.FourStemWorkstation(dur, fps=fps, world='scifi', target_lufs=-14.0, max_tp=-1.5)
        ws.set_music(H.music_like(dur, seed=12), target_lufs=-24.0)
        placed = ws.bind_actor(
            kin,
            'hovercraft',
            engine_tex,
            bus='fx',
            role='accent',
            shot_scale='medium',
            velocity_mps=6.0,
            ref_scale=0.35,
            loop_sustained=True,
            seed=7,
        )
        self.assertEqual(len(placed), 1)
        self.assertEqual(placed[0]['actor_id'], 'hovercraft')
        self.assertAlmostEqual(placed[0]['t0'], 6 / fps, places=3)
        self.assertAlmostEqual(placed[0]['t1'], 84 / fps, places=3)
        self.assertAlmostEqual(placed[0]['peak_scale'], 0.55, places=3)

        _, stems, _ = ws.mixdown()
        fx_st = stems['fx']
        self.assertEqual(float(np.max(np.abs(fx_st[:D.N(0.20)]))), 0.0)
        self.assertEqual(float(np.max(np.abs(fx_st[D.N(3.65):]))), 0.0)

        far_left = fx_st[D.N(0.35):D.N(0.95)]
        near_right = fx_st[D.N(2.75):D.N(3.35)]
        self.assertGreater(D.rms(far_left[:, 0]), D.rms(far_left[:, 1]) * 1.45, '起始段应显著偏左声道')
        self.assertGreater(D.rms(near_right[:, 1]), D.rms(near_right[:, 0]) * 1.45, '收尾段应显著偏右声道')
        gain_rise_db = 20.0 * np.log10((D.rms(near_right) + 1e-12) / (D.rms(far_left) + 1e-12))
        self.assertGreater(gain_rise_db, 8.0, f'近景相对远景增益抬升不足 +8 dB：实测 {gain_rise_db:+.2f} dB')

        # 同时验证 kinematics.json 文件路径输入与 bus='foley' 路由
        kin_path = os.path.join(self.td, 'actor_kin.json')
        with open(kin_path, 'w', encoding='utf-8') as f:
            json.dump({'fps': fps, 'dur': dur, 'tracks': {'runner': {'x': xs, 'scale': scales, 'visible': vis}}}, f)
        ws2 = ED.FourStemWorkstation(dur, fps=fps, world='realistic')
        placed_f = ws2.bind_actor(kin_path, 'runner', engine_tex, bus='foley', shot_scale='wide', seed=3)
        self.assertEqual(len(placed_f), 1)
        self.assertEqual(placed_f[0]['bus'], 'foley')

    def test_stream_master_chain_parity_and_multi_chunk_60s_180s_zero_seams(self):
        """验证 stream.bus_glue_compress / stream.master_chain 与 mixing.master_chain 的精度对齐，
        以及 60s / 180s 多分块（10.0s 接缝）零咔嗒与 <1.0 GB 低内存预算。"""
        r = D.rng(303)

        # 1) stream.bus_glue_compress 与 mixing.bus_glue_compress 逐样本与 GR 曲线对齐，且跨任意块长一致
        sig_12 = H.music_like(12.0, seed=17) * 0.55
        ref_comp, ref_gr = MX.bus_glue_compress(
            sig_12.copy(), threshold_db=-19.0, ratio=2.2, attack_ms=25.0, release_ms=160.0, knee_db=6.0, sc_hpf_hz=110.0
        )
        s_buf = sig_12.astype(np.float32)
        s_comp, s_gr = S.bus_glue_compress(
            s_buf, threshold_db=-19.0, ratio=2.2, attack_ms=25.0, release_ms=160.0, knee_db=6.0, sc_hpf_hz=110.0, chunk_s=2.7
        )
        self.assertIs(s_comp, s_buf)
        self.assertLess(float(np.max(np.abs(s_gr.astype(np.float64) - ref_gr))), 2e-3)
        self.assertLess(float(np.max(np.abs(s_comp.astype(np.float64) - ref_comp))), 2e-4)

        # 2) 12s 测试混音上对比 stream.master_chain 与 mixing.master_chain，同时核验 HDRMixer.set_dialogue 直接调用
        mx_direct = DR.HDRMixer(4.0, fps=24.0, target_lufs=-14.0, max_tp=-1.5)
        mx_direct.add_bed('music', H.music_like(4.0, seed=5), target_lufs=-18.5, how='win')
        mx_direct.set_dialogue(_synth_articulate_vo(4.0, [(0.6, 2.8)], seed=9), target_lufs=-16.0)
        _, direct_stems, direct_diag = mx_direct.render()
        self.assertIn('vo', direct_stems)
        self.assertTrue(direct_diag['dialogueEnabled'])

        dur_12 = 12.0
        t12 = D.T(dur_12)
        arc12 = D.curve([(0.0, 0.22), (4.0, 0.38), (8.5, 0.78), (11.8, 0.65)], t12)
        mix12 = (
            D.stereo(0.32 * np.sin(2.0 * np.pi * 130.81 * t12) + 0.24 * np.sin(2.0 * np.pi * 261.63 * t12), 0.0)
            + H.music_like(dur_12, seed=29) * 0.45
        ) * arc12[:, None]
        mix12[D.N(6.20):D.N(6.20) + 20] += 0.65  # 孤立微瞬态尖峰

        ref_m, ref_diag = MX.master_chain(
            mix12.copy(), target_lufs=-13.3, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=3.2
        )
        bus12 = mix12.astype(np.float32)
        str_m, str_diag = S.master_chain(
            bus12, target_lufs=-13.3, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=3.2, chunk_s=4.0
        )
        self.assertIs(str_m, bus12)
        self.assertEqual(len(str_m), len(ref_m))
        self.assertEqual(set(str_diag.keys()), set(ref_diag.keys()))
        self.assertLess(abs(str_diag['finalLufs'] - ref_diag['finalLufs']), 0.05, (str_diag, ref_diag))
        self.assertAlmostEqual(M.integrated(str_m.astype(np.float64)), -13.3, delta=0.05)
        self.assertLessEqual(str_diag['truePeakDbtp'], -1.5 + 0.05)
        self.assertGreaterEqual(str_diag['glueMaxGrDb'], 1.0)
        self.assertLessEqual(str_diag['glueMaxGrDb'], 3.3)

        # 3) 60s 与 180s 多分块（chunk_s=10.0）实测：检验每个 10.0s 块边界零跳变咔嗒，且推算 600s 内存远低于 1.0 GB
        peak_alloc_mb = {}
        for dur_long in (60.0, 180.0):
            nl = D.N(dur_long)
            bus_long = S.Bus(nl, 'long_master', dtype=np.float32)
            # 用分段等功率底层构造平滑连续长片混音（避开 10.0s 整数倍交叉点，专门检验 10.0s 母带分块边界）
            S.bed(
                bus_long,
                lambda d, s: H.music_like(d, seed=s + 50, lp_hz=6500) * (0.28 + 0.16 * ((s % 3) / 2.0)),
                0.0,
                dur_long,
                seg=17.0,
                xf=1.2,
                seed=10,
            )
            # 每隔 3.3s 放置一记清脆拟音瞬态
            hit_t = 1.4
            hit_clip = (0.55 * np.exp(-D.T(0.14) / 0.03) * D.bp(r.standard_normal(D.N(0.14)), 600.0, 5800.0, 2)).astype(np.float32)
            while hit_t < dur_long - 1.0:
                bus_long.place(hit_clip, hit_t, gain=0.65, pan=float(np.sin(hit_t)))
                hit_t += 3.3

            tracemalloc.start()
            try:
                _, d_long = S.master_chain(
                    bus_long.buf,
                    target_lufs=-13.3,
                    max_tp=-1.5,
                    glue=True,
                    glue_ratio=2.0,
                    max_gr_db=3.2,
                    chunk_s=10.0,
                )
                _, peak_bytes = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()

            buf_mb = bus_long.buf.nbytes / (1024.0 * 1024.0)
            peak_alloc_mb[dur_long] = buf_mb + peak_bytes / (1024.0 * 1024.0)

            self.assertAlmostEqual(d_long['finalLufs'], -13.3, delta=0.05)
            self.assertLessEqual(d_long['truePeakDbtp'], -1.5 + 0.05)
            self.assertGreaterEqual(d_long['glueMaxGrDb'], 1.5)
            self.assertLessEqual(d_long['glueMaxGrDb'], 3.25)
            self.assertEqual(float(np.max(np.abs(bus_long.buf[0]))), 0.0)
            self.assertEqual(float(np.max(np.abs(bus_long.buf[-1]))), 0.0)

            # 逐一检验全部 10.0s 分块边界（10s, 20s, ...）：边界单样本差必须与邻域样本差同阶，零阶跃咔嗒
            w_ctx = D.N(0.032)
            for seam_s in range(10, int(dur_long), 10):
                c_idx = D.N(float(seam_s))
                seg = bus_long.buf[c_idx - w_ctx:c_idx + w_ctx].astype(np.float64)
                ratio, jump = QA._cut_ratio(seg, w_ctx)
                self.assertIsNotNone(ratio)
                self.assertLess(
                    ratio,
                    2.2,
                    f'{dur_long}s 混音在 {seam_s}.0s 分块接缝处出现异常跳变：ratio={ratio}, jump={jump}',
                )
            del bus_long

        slope_mb_per_s = max(0.0, (peak_alloc_mb[180.0] - peak_alloc_mb[60.0]) / 120.0)
        est_600s_mb = peak_alloc_mb[180.0] + slope_mb_per_s * 420.0
        self.assertLess(
            est_600s_mb,
            1000.0,
            f'600s 流式粘合母带推算峰值内存超 1.0 GB：{est_600s_mb:.1f} MB ({peak_alloc_mb})',
        )


if __name__ == '__main__':
    unittest.main()
