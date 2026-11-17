# -*- coding: utf-8 -*-
"""导演声学谱与感知 HDR 混音层 engine/audio/director.py 单元测试与 QA 闭环实测。"""
import os
import shutil
import unittest

import numpy as np

import _audiotest as H
from engine.audio import cues as C
from engine.audio import director as DR
from engine.audio import dsp as D
from engine.audio import foley as F
from engine.audio import qa as QA


class DirectorScoreAndHdrTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('audio-director')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_harmonic_freq_snaps_to_pentatonic_scale(self):
        """剑鸣与提示音吸附到 D 五声调式主干音级（F#6≈1480.0 Hz、A6=1760.0 Hz、D6≈1174.7 Hz）。"""
        self.assertAlmostEqual(DR.harmonic_freq(1465.0, root='D', scale='pentatonic'), 1479.978, delta=0.2)
        self.assertAlmostEqual(DR.harmonic_freq(1715.0, root='D', scale='pentatonic'), 1760.000, delta=0.2)
        self.assertAlmostEqual(DR.harmonic_freq(1190.0, root='D', scale='fifth'), 1174.659, delta=0.2)

    def test_poa_perspective_contrast_intimate_vs_open_sky(self):
        """近景 intimate_dry 声场应显著窄于第一视角 open_sky，且跨切点带平滑 L-cut 尾音。"""
        rng = np.random.default_rng(11)
        dur = 4.0
        src = D.decor_pair(D.pink, D.N(2.6), rng, corr=0.1) * 0.25
        close_st = DR.render_shot_poa(src, 0.0, 2.0, dur, poa='intimate_dry')
        open_st = DR.render_shot_poa(src, 0.0, 2.0, dur, poa='open_sky')

        def sm_ratio(st):
            seg = st[D.N(0.4):D.N(1.6)]
            mid = 0.5 * (seg[:, 0] + seg[:, 1])
            side = 0.5 * (seg[:, 0] - seg[:, 1])
            return float(np.sqrt(np.mean(side ** 2) + 1e-20) / np.sqrt(np.mean(mid ** 2) + 1e-20))

        self.assertGreater(sm_ratio(open_st), sm_ratio(close_st) * 1.8)
        # open_sky 在 2.0s 切走后仍有 L-cut 余韵（2.05..2.20s 非零）
        self.assertGreater(D.rms(open_st[D.N(2.05):D.N(2.20)]), 1e-4)

    def test_hdr_mixer_murch_culling_negative_space_and_spectral_ducking_passes_qa(self):
        """高密度并发场景：HDRMixer 自动执行 Murch 2.5 声部聚簇、冲击前负空间抽空与临界频带闪避，100% 过 QA 门（不伤配乐低频）。"""
        rng = np.random.default_rng(42)
        dur = 8.0
        fps = 24
        nf = int(dur * fps)
        n = D.N(dur)

        # 构造模拟页面真遥测：第 96 帧（4.00s）断水冲击在画面右侧 pan = +0.62
        pan_frames = [0.62 if 90 <= f <= 105 else -0.2 for f in range(nf)]
        mot_frames = [0.95 if 94 <= f <= 100 else 0.15 for f in range(nf)]
        kin = C.Kinematics({'fps': fps, 'dur': dur, 'tracks': {'screen': {'x': pan_frames, 'motion': mot_frames}}})

        # 厚重全频带配乐（既有 90–220 Hz 大提琴低音底盘，又有极强的 1.5–6 kHz 弦乐擦弦，足以淹没普通前景音效）
        t = D.T(dur)
        cello = 0.45 * np.sin(2 * np.pi * 146.83 * t) + 0.25 * np.sin(2 * np.pi * 220.0 * t)
        bright_wall = D.bp(rng.standard_normal(n), 1400.0, 6500.0, 2) * 0.55
        music_raw = D.stereo(cello + bright_wall, 0.0)
        amb_raw = D.decor_pair(D.pink, n, rng, corr=0.2) * 0.25

        mixer = DR.HDRMixer(dur, fps=fps, target_lufs=-14.0, max_tp=-1.5, murch_limit=2, telemetry=kin)
        mixer.add_bed('music', music_raw, target_lufs=-14.5, how='win', t0=0.2, t1=dur - 0.2)
        mixer.add_bed('amb', amb_raw, target_lufs=-22.0, how='win', t0=0.2, t1=dur - 0.2)

        # 断水冲击前 6 帧挖 -14 dB 负空间
        t_hit = 96 / fps
        mixer.add_negative_space(frame=96, lead_frames=6, hold_frames=1, dip_db=-14.0, recover_sec=0.5)

        # 主角断水音效（P-Center 对齐第 96 帧，调性吸附 D 调，声像自动从遥测读取）
        cleave_w, cleave_anc = F.water_cleave(dur=1.4, force=1.1, key='D', seed=7)
        mixer.add_cue('cleave', cleave_w, t_hit, anchor=cleave_anc, role='hero', target_lufs=-16.5)

        # 同窗塞入 3 个次要并发音效验证 Murch 2.5 聚簇裁剪（cleave + sup1 保全，sup2/sup3 退居群像层）
        for k, prio in enumerate((78.0, 62.0, 55.0), start=1):
            sw, sa = F.blade_whoosh(0.22, seed=20 + k)
            mixer.add_cue(f'sup{k}', sw, t_hit + 0.01 * k, anchor=sa, role='support', priority=prio, target_lufs=-23.0)

        # 第 144 帧（6.00s）极轻的眼镜编码层提示音（测试在厚重弦乐上切开 1.5–3.5 kHz 听觉窥视窗口而不抽吸低音）
        ping = np.sin(2 * np.pi * DR.harmonic_freq(1760.0, root='D') * D.T(0.12)) * np.exp(-D.T(0.12) / 0.04)
        mixer.add_cue('ui_ping', ping, 144 / fps, anchor=0.0, role='ui', target_lufs=-24.0, pan=0.0)

        mix, stems, diag = mixer.render()
        self.assertEqual(diag['culledCount'], 2)
        self.assertEqual(set(diag['culledIds']), {'sup2', 'sup3'})
        self.assertIn('ui_ping', diag['spectralDucked'])

        # 验证遥测声像自动传递：cleave 在右侧（右声道能量显著高于左声道）
        seg_fx = stems['fx'][D.N(t_hit - 0.01):D.N(t_hit + 0.08)]
        self.assertGreater(D.rms(seg_fx[:, 1]), D.rms(seg_fx[:, 0]) * 1.15)

        # 验证 6.00s 频带闪避只挖了中高频，大提琴 80–250 Hz 低频底盘几乎不受损（衰减 < 1.0 dB）
        m_pre = D.bp(stems['music'][D.N(5.4):D.N(5.8), 0], 80.0, 250.0, 2)
        m_at = D.bp(stems['music'][D.N(5.99):D.N(6.18), 0], 80.0, 250.0, 2)
        low_drop_db = 20.0 * np.log10((D.rms(m_at) + 1e-12) / (D.rms(m_pre) + 1e-12))
        self.assertGreater(low_drop_db, -1.0, f'配乐低频底盘不应被抽吸：实测变化 {low_drop_db:.2f} dB')

        # 落盘跑真实 engine.audio.qa 门禁（含 audio.masking、响度、真峰值、单声道兼容）
        fdir = os.path.join(self.td, 'hdr-film')
        events = [
            {'id': 'cleave', 'frame': 96, 'shot': 'S1', 'audio': 'cleave', 'domain': 'sfx', 'syncMode': 'pcenter'},
            {'id': 'ui_ping', 'frame': 144, 'shot': 'S2', 'audio': 'ui_ping', 'domain': 'ui', 'bus': 'ui'},
        ]
        H.film_json(fdir, frames=nf, fps=fps, cuts=(120,), events=events)
        C.write(os.path.join(fdir, 'out'), mix, stems=stems)
        checks, _ = QA.analyze(
            os.path.join(fdir, 'out', 'mix.wav'),
            fps=fps, frames=nf, cuts=(120,), target_lufs=-14.0, tol_lu=0.5, max_tp=-1.0,
            loudness_at='mix', film={'fps': fps, 'events': events, 'audio': {}, 'dir': fdir, 'cuts': (120,)},
        )
        by_id = {c['id']: c for c in checks}
        self.assertEqual(by_id['audio.loudness']['status'], 'pass', by_id['audio.loudness'])
        self.assertEqual(by_id['audio.truepeak']['status'], 'pass', by_id['audio.truepeak'])
        self.assertEqual(by_id['audio.masking']['status'], 'pass', by_id['audio.masking'])

    def test_subtle_precision_cue_is_non_tonal_and_whisper_restrained(self):
        """工程制图引出线 subtle_precision_cue：仅含 ≤4ms 怀表擒纵微触点与纸面轻擦，无周期电子铃音（pitch_prominence < 0.35）。"""
        from engine.audio import sfx_judge as SJ
        rng = np.random.default_rng(88)
        watch_tick = np.exp(-D.T(0.02) / 0.0012) * rng.standard_normal(D.N(0.02))
        paper_trace = D.bp(rng.standard_normal(D.N(0.25)), 900.0, 6200.0, 2) * 0.25
        cue_w, cue_anc = DR.subtle_precision_cue(
            tick_sample=watch_tick, trace_sample=paper_trace, dur=0.11, tick_ms=3.0, trace_gain=0.15, seed=5
        )
        self.assertLess(cue_anc, 0.006)
        m = SJ.extract_metrics(cue_w, D.SR)
        self.assertLess(m['pitch_prominence'], 0.35, f'精密划线不应带周期电子铃音：{m}')
        # 前 6 ms 能量远高于尾段，确保干脆微距触感
        self.assertGreater(D.rms(cue_w[:D.N(0.006)]), D.rms(cue_w[D.N(0.025):]) * 3.0)

    def test_hitech_laser_trace_and_micro_beep_high_freq_without_ear_harshness(self):
        """高科技镭射脉冲走线与微菜单 beep：主能量在 >5kHz 晶莹高频区，且 3–4.5kHz 刺耳区显著低于高频主瓣（不扎耳朵）。"""
        laser_w, _ = DR.hitech_laser_trace(dur=0.36, f_lo=7200.0, f_hi=12400.0, elbow_at=0.16, seed=12)
        self.assertEqual(len(laser_w), D.N(0.36))
        sp = np.abs(np.fft.rfft(laser_w)) ** 2
        fq = np.fft.rfftfreq(len(laser_w), 1.0 / D.SR)
        e_harsh = float(sp[(fq >= 2800.0) & (fq <= 4600.0)].sum())
        e_silky_hi = float(sp[(fq >= 6500.0) & (fq <= 13500.0)].sum())
        self.assertGreater(e_silky_hi, e_harsh * 8.0)

        beep_w, _ = DR.hitech_micro_beep(freq_hz=2960.0, root='D', pattern='double', dur=0.08, seed=7)
        self.assertEqual(len(beep_w), D.N(0.08))
        self.assertGreater(D.rms(beep_w), 0.05)

        # 核心镜头强调模式：在原同源 beep 上叠入高五度/八度晶莹泛音层，高频泛音占比显著提升
        emp_w, _ = DR.hitech_micro_beep(freq_hz=2960.0, root='D', pattern='double', dur=0.10, emphasis_layer=True, seed=7)
        sp_b = np.abs(np.fft.rfft(beep_w)) ** 2
        sp_e = np.abs(np.fft.rfft(emp_w)) ** 2
        fq_b = np.fft.rfftfreq(len(beep_w), 1.0 / D.SR)
        fq_e = np.fft.rfftfreq(len(emp_w), 1.0 / D.SR)
        hi_b = float(sp_b[fq_b >= 4200.0].sum() / (sp_b.sum() + 1e-20))
        hi_e = float(sp_e[fq_e >= 4200.0].sum() / (sp_e.sum() + 1e-20))
        self.assertGreater(hi_e, hi_b * 2.0)

        # 微距景别声像上限（SHOT_PAN_CAP）：传入 shot_scale='macro' 时标量极左声像 -0.75 被收束到 ±0.12
        mx = DR.HDRMixer(1.0)
        mx.add_cue('pen_btn', beep_w, 0.4, pan=-0.75, shot_scale='macro')
        self.assertAlmostEqual(mx._cues[-1]['pan'], -DR.SHOT_PAN_CAP['macro'], places=5)

        # 精密齿轮显式悬停与落锁跃迁参数
        from engine.audio import foley as FL
        gw, g_anc = FL.precision_gear_turn(0.14, teeth=4, hover_ms=38.0, lock_jump_db=6.0, seed=5)
        self.assertAlmostEqual(g_anc, 0.14, places=4)
        self.assertGreater(len(gw), D.N(0.20))


if __name__ == '__main__':
    unittest.main()
