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
from engine.audio import meter as M
from engine.audio import mixing as MX
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

    def test_three_stems_scene_cut_micro_xfade_span_trim_and_pan_trajectory(self):
        """验证三干线分轨（amb/fx/foley）、室外切室内微交叉淡化无咔嗒、素材按画面时长裁切淡出、以及从左飞到右连续声像轨迹。"""
        rng = np.random.default_rng(42)
        dur = 4.0
        mx = DR.HDRMixer(dur, fps=24.0, world='realistic')

        # 1. 室外（高频风声）在 2.000s 硬切室内（低频室温音）：55ms 微交叉淡化消除台阶且不把室外风漏进 2.2s 以后
        outdoor = D.bp(rng.standard_normal(D.N(2.5)), 800.0, 4500.0, 2) * 0.15
        indoor = D.lp(rng.standard_normal(D.N(2.5)), 240.0, 2) * 0.08
        mx.add_scene_ambience([
            {'in_s': 0.0, 'out_s': 2.0, 'wave': outdoor, 'transition': 'hard_cut'},
            {'in_s': 2.0, 'out_s': 4.0, 'wave': indoor, 'transition': 'hard_cut'},
        ], target_lufs=-30.0, hard_xfade_s=0.055)

        # 检查 2.0s 切点前后无零样本硬跳变，且 2.15s 后高频风声已完全消失
        amb = mx.beds['amb']
        cut_i = D.N(2.0)
        jump = float(np.max(np.abs(amb[cut_i] - amb[cut_i - 1])))
        local_diff = float(np.percentile(np.abs(np.diff(amb[cut_i - 400:cut_i + 400], axis=0)), 99))
        self.assertLess(jump, local_diff * 2.5)
        hi_outdoor = D.rms(D.hp(amb[D.N(0.5):D.N(1.5)], 1200.0, 2))
        hi_indoor = D.rms(D.hp(amb[D.N(2.15):D.N(3.5)], 1200.0, 2))
        self.assertGreater(hi_outdoor, hi_indoor * 8.0)

        # 2. 原始 2.0s 的长摩擦音效绑定到 0.35s 画面元素：自动裁切并淡出，0.45s 后完全归零
        long_sfx = np.sin(2 * np.pi * 440.0 * D.T(2.0)) * 0.5
        mx.add_cue('short_slide', long_sfx, 0.5, span_dur=0.35, role='support', bus='fx')

        # 3. 连续动态声像：物体在 2.2s..3.6s 从左 (-0.80) 飞到右 (+0.80)，并写入独立 foley 分轨
        buzz = D.bp(rng.standard_normal(D.N(1.4)), 180.0, 1400.0, 2) * 0.4
        mx.add_cue(
            'flying_bee', buzz, 2.2, role='foley', bus='foley', shot_scale='full',
            pan=[(0.0, -0.80), (1.4, 0.80)], doppler_mps=6.0,
        )

        _, stems, _ = mx.render()
        self.assertIn('foley', stems)
        self.assertEqual(float(np.max(np.abs(stems['fx'][D.N(0.88):D.N(1.80)]))), 0.0)
        # 起飞段左声道能量显著大于右声道，收尾段右声道能量显著大于左声道
        l_start = D.rms(stems['foley'][D.N(2.25):D.N(2.55), 0])
        r_start = D.rms(stems['foley'][D.N(2.25):D.N(2.55), 1])
        l_end = D.rms(stems['foley'][D.N(3.25):D.N(3.55), 0])
        r_end = D.rms(stems['foley'][D.N(3.25):D.N(3.55), 1])
        self.assertGreater(l_start, r_start * 2.2)
        self.assertGreater(r_end, l_end * 2.2)

    def test_screen_scale_to_distance_and_depth_gain_db(self):
        """画面元素占画高比例 r ∈ (0, 1] → 声学距离 d(t) 与纵深增益：大远景 1/12 与近景 0.45 天然拉开 10–14 dB。"""
        d_ref = DR.screen_scale_to_distance(0.45)
        d_s1_far = DR.screen_scale_to_distance(1.0 / 12.0)
        d_s8_recede = DR.screen_scale_to_distance(1.0 / 7.0)
        d_close = DR.screen_scale_to_distance(0.85)
        self.assertAlmostEqual(d_ref, 1.80, places=3)
        self.assertGreater(d_s1_far, 8.0)
        self.assertGreater(d_s8_recede, 4.8)
        self.assertLess(d_close, 1.1)

        # 数组输入与上下界钳制
        d_arr = DR.screen_scale_to_distance([1e-4, 0.45, 2.0])
        self.assertEqual(d_arr.shape, (3,))
        self.assertAlmostEqual(float(d_arr[0]), 28.0, places=3)
        self.assertAlmostEqual(float(d_arr[1]), 1.80, places=3)
        self.assertGreaterEqual(float(d_arr[2]), 0.55)

        g_ref = DR.depth_gain_db(d_ref)
        g_far = DR.depth_gain_db(d_s1_far)
        g_s8 = DR.depth_gain_db(d_s8_recede)
        self.assertAlmostEqual(g_ref, 0.0, places=4)
        self.assertLessEqual(g_far, -10.5)
        self.assertGreaterEqual(g_far, -15.5)
        self.assertLessEqual(g_s8, -8.2)

        # 验证 HDRMixer.add_cue 传入 screen_ratio 时，远景不会被 match_level 反向抹平，且空气高频显著柔化
        rng = np.random.default_rng(71)
        dur = 4.0
        mx = DR.HDRMixer(dur, fps=24.0, world='semi_realistic')
        tram_src = D.bp(rng.standard_normal(D.N(0.85)), 160.0, 9500.0, 2) * 0.45
        mx.add_cue('tram_far_s1', tram_src, 0.5, role='support', bus='fx', screen_ratio=1.0 / 12.0)
        mx.add_cue('tram_near_s2', tram_src, 2.2, role='support', bus='fx', screen_ratio=0.45)
        _, stems, _ = mx.render()
        seg_far = stems['fx'][D.N(0.55):D.N(1.25)]
        seg_near = stems['fx'][D.N(2.25):D.N(2.95)]
        diff_db = 20.0 * np.log10((D.rms(seg_near) + 1e-12) / (D.rms(seg_far) + 1e-12))
        self.assertGreater(diff_db, 10.0)
        self.assertLess(diff_db, 16.5)

        sp_far = np.abs(np.fft.rfft(seg_far.mean(axis=1))) ** 2
        sp_near = np.abs(np.fft.rfft(seg_near.mean(axis=1))) ** 2
        fq = np.fft.rfftfreq(len(seg_far), 1.0 / D.SR)
        hf_far = float(sp_far[fq >= 6000.0].sum() / (sp_far.sum() + 1e-20))
        hf_near = float(sp_near[fq >= 6000.0].sum() / (sp_near.sum() + 1e-20))
        self.assertGreater(hf_near, hf_far * 1.8)

    def test_music_ceiling_headroom_continuous_duck_and_stem_tp_protection(self):
        """验证配乐净空上限（不吞噬 95% 母带能量）、music_focus_windows 情绪放开、持续动作让路与分轨 tp_limit 零削波。"""
        rng = np.random.default_rng(93)
        dur = 6.0
        n = D.N(dur)
        t = D.T(dur)

        # 构造极满幅配乐（原电平 -15.0 LUFS）+ 持续 2.2s 的链条/轨道前景音 + 一记高波峰因数尖锐瞬态
        music_hot = D.stereo(
            0.35 * np.sin(2 * np.pi * 196.0 * t)
            + 0.45 * D.bp(rng.standard_normal(n), 250.0, 6200.0, 2),
            0.0,
        )
        mx = DR.HDRMixer(
            dur,
            fps=24.0,
            target_lufs=-14.0,
            max_tp=-1.5,
            music_ceiling_offset_db=-5.5,
            music_focus_windows=[(4.5, 6.0)],
            continuous_duck_db=4.5,
        )
        mx.add_bed('music', music_hot, target_lufs=-15.0, how='win', t0=0.0, t1=dur)
        mx.add_bed('amb', D.decor_pair(D.pink, n, rng, corr=0.4) * 0.12, target_lufs=-29.0, how='win', t0=0.0, t1=dur)

        sustained_rail = D.bp(rng.standard_normal(D.N(2.2)), 200.0, 5800.0, 2) * 0.40
        mx.add_cue('rail_run', sustained_rail, 0.8, role='support', bus='fx', target_lufs=-18.5)

        sharp_hit = np.zeros(D.N(0.16))
        sharp_hit[20:45] = 1.0
        sharp_hit += 0.20 * np.exp(-D.T(0.16) / 0.03) * D.bp(rng.standard_normal(D.N(0.16)), 500.0, 7000.0, 2)
        mx.add_cue('sharp_slam', sharp_hit, 3.6, role='hero', bus='fx', target_lufs=-13.5, gain_db=4.5)

        master, stems, diag = mx.render()
        self.assertAlmostEqual(M.integrated(master), -14.0, delta=0.25)
        self.assertGreater(diag['continuousDuckMaxDb'], 2.0)

        # 叙事段（0.3..4.2s）配乐响度必须显著低于母带 -14 LUFS（留足 -4.5 dB 以上净空），且片尾焦点窗（4.7..5.8s）显著上扬
        mus_narr_lufs = M.integrated(stems['music'][D.N(0.3):D.N(4.2)])
        mus_focus_lufs = M.integrated(stems['music'][D.N(4.7):D.N(5.85)])
        self.assertLessEqual(mus_narr_lufs, -18.2, f'叙事段配乐未压住净空：{mus_narr_lufs:.2f} LUFS')
        self.assertGreater(mus_focus_lufs - mus_narr_lufs, 2.5, 'music_focus_windows 片尾情绪未明显放开上扬')

        # 所有导出分轨真峰值严格 ≤ -1.48 dBTP，零满幅硬削波样本
        for k, st_arr in stems.items():
            if float(np.max(np.abs(st_arr))) > 1e-6:
                tp_db = 20.0 * np.log10(max(M.true_peak(st_arr, os=4), 1e-12))
                self.assertLessEqual(tp_db, -1.48, f'分轨 {k} 真峰值超限: {tp_db:.2f} dBTP')
                self.assertEqual(int((np.abs(st_arr) >= 0.9999).sum()), 0, f'分轨 {k} 发生满幅削波')

    def test_bus_glue_compress_and_master_chain_preserve_transients_and_lra(self):
        """验证 SSL 总线粘合压缩（25ms 慢起音保前 20ms 瞬态、110Hz 侧链防低频抽吸）与四步透明母带链（-13.3 LUFS 且保宏观 LRA）。"""
        dur = 10.0
        n = D.N(dur)
        t = D.T(dur)
        rng = np.random.default_rng(204)

        # 1) 25ms 慢起音完整放过前 18ms 清脆瞬态：突变高电平阶跃前 15ms 平均 GR 显著小于稳态 80ms 后 GR
        step_sig = np.zeros((D.N(0.50), 2), dtype=float)
        step_sig[D.N(0.10):] = D.stereo(0.55 * np.sin(2.0 * np.pi * 880.0 * D.T(0.40)), 0.0)
        _, gr_step = MX.bus_glue_compress(
            step_sig, threshold_db=-18.0, ratio=2.5, attack_ms=25.0, release_ms=160.0, knee_db=6.0, sc_hpf_hz=110.0
        )
        gr_first_16ms = float(np.mean(gr_step[D.N(0.100):D.N(0.116)]))
        gr_steady = float(np.mean(gr_step[D.N(0.200):D.N(0.320)]))
        self.assertGreater(gr_steady, 3.0)
        self.assertLess(gr_first_16ms, gr_steady * 0.48, f'25ms 慢起音未保护前 16ms 瞬态: {gr_first_16ms:.2f} vs {gr_steady:.2f}')

        # 2) 110 Hz 侧链高通防止 50 Hz 滚雷超低频引发全曲抽吸
        sub_thunder = D.stereo(0.60 * np.sin(2.0 * np.pi * 50.0 * D.T(0.60)), 0.0)
        mid_chord = D.stereo(0.60 * np.sin(2.0 * np.pi * 660.0 * D.T(0.60)), 0.0)
        _, gr_sub = MX.bus_glue_compress(sub_thunder, threshold_db=-16.0, ratio=2.0, sc_hpf_hz=110.0)
        _, gr_mid = MX.bus_glue_compress(mid_chord, threshold_db=-16.0, ratio=2.0, sc_hpf_hz=110.0)
        self.assertLess(float(np.max(gr_sub)), float(np.max(gr_mid)) * 0.45)

        # 并行干湿比 mix=0.0 时完全透明零衰减
        dry_chk, gr_zero = MX.bus_glue_compress(mid_chord, threshold_db=-24.0, ratio=4.0, mix=0.0)
        self.assertTrue(np.allclose(dry_chk, mid_chord))
        self.assertEqual(float(np.max(gr_zero)), 0.0)

        # 3) master_chain 四步透明母带：构造大动态叙事段落（0-3.5s 轻柔竖琴 -> 3.5-6.5s 中段律动 -> 6.5-10s 管弦高潮 + 孤立尖峰 + 低频反相噪声）
        env_arc = D.curve([(0.0, 0.15), (3.3, 0.17), (3.8, 0.36), (6.3, 0.38), (7.0, 0.75), (9.8, 0.70)], t)
        mus_body = (
            0.45 * np.sin(2.0 * np.pi * 146.83 * t)
            + 0.35 * np.sin(2.0 * np.pi * 293.66 * t)
            + 0.30 * D.bp(rng.standard_normal(n), 320.0, 4800.0, 2)
        ) * env_arc
        st_in = D.stereo(mus_body, 0.0)
        # 注入 <80 Hz 左右反相立体声低频浑浊分量 + 一记孤立尖峰瞬态 + 轻微直流偏移
        low_antiphase = D.lp(rng.standard_normal(n), 72.0, 2) * 0.12
        st_in[:, 0] += low_antiphase + 0.004
        st_in[:, 1] -= low_antiphase - 0.004
        st_in[D.N(7.40):D.N(7.40) + 18] += 0.85

        from engine.audio.stream import Loudness
        L_pre = Loudness()
        L_pre.feed(st_in)
        lra_in = L_pre.lra()

        master_st, m_diag = MX.master_chain(
            st_in, target_lufs=-13.3, max_tp=-1.5, glue=True, glue_ratio=2.0, max_gr_db=3.2,
            sub_hpf_hz=28.0, mono_bass_hz=100.0, air_db=0.5,
        )
        self.assertAlmostEqual(M.integrated(master_st), -13.3, delta=0.10)
        self.assertAlmostEqual(m_diag['finalLufs'], -13.3, delta=0.12)
        self.assertLessEqual(20.0 * np.log10(max(M.true_peak(master_st, os=4), 1e-12)), -1.48)
        self.assertGreaterEqual(m_diag['glueMaxGrDb'], 1.5)
        self.assertLessEqual(m_diag['glueMaxGrDb'], 3.25)
        # 宏观动态 LRA 完整保留（未被压扁）
        self.assertGreater(m_diag['lra'], 5.0)
        self.assertLess(abs(m_diag['lra'] - lra_in), 2.0)
        # <100 Hz M/S 侧声道反相低频被显著收紧，直流消除，首尾样本归零
        side_in_lo = D.rms(D.lp(0.5 * (st_in[:, 0] - st_in[:, 1]), 75.0, 2)) / (D.rms(0.5 * (st_in[:, 0] + st_in[:, 1])) + 1e-12)
        side_out_lo = D.rms(D.lp(0.5 * (master_st[:, 0] - master_st[:, 1]), 75.0, 2)) / (D.rms(0.5 * (master_st[:, 0] + master_st[:, 1])) + 1e-12)
        self.assertLess(side_out_lo, side_in_lo * 0.45)
        self.assertLess(float(np.max(np.abs(master_st.mean(axis=0)))), 5e-4)
        self.assertEqual(float(np.max(np.abs(master_st[0]))), 0.0)
        self.assertEqual(float(np.max(np.abs(master_st[-1]))), 0.0)

    def test_volume_curve_sculpt_stem_eq_and_balanced_hdr_defaults(self):
        """验证推子音量曲线 volume_curve、互补 EQ sculpt_stem_eq，以及 HDRMixer 新黄金默认配比（杜绝把配乐压到 -25 LUFS）。"""
        rng = np.random.default_rng(309)
        dur = 6.0
        n = D.N(dur)

        # 1) volume_curve 余弦平滑断点插值
        vc = DR.volume_curve(n, [(0.0, 0.0), (2.0, -6.0), (4.0, +3.0)], dur=dur, smooth=True)
        self.assertEqual(vc.shape, (n, 1))
        self.assertAlmostEqual(float(vc[0, 0]), 1.0, places=4)
        self.assertAlmostEqual(float(vc[D.N(2.0), 0]), float(D.undb(-6.0)), places=3)
        self.assertAlmostEqual(float(vc[D.N(4.5), 0]), float(D.undb(3.0)), places=3)
        # 无三次样条过冲：全程严格夹在 [-6 dB, +3 dB] 之间
        self.assertGreaterEqual(float(np.min(vc)), float(D.undb(-6.0)) - 1e-6)
        self.assertLessEqual(float(np.max(vc)), float(D.undb(3.0)) + 1e-6)

        # 2) sculpt_stem_eq 分轨互补频谱凹槽验证
        white_st = D.stereo(rng.standard_normal(n) * 0.2, 0.0)
        sculpted = DR.sculpt_stem_eq({'amb': white_st, 'foley': white_st, 'fx': white_st, 'music': white_st})
        fq = np.fft.rfftfreq(n, 1.0 / D.SR)

        def band_db_diff(after_st, before_st, f_lo, f_hi):
            pa = float((np.abs(np.fft.rfft(after_st[:, 0])) ** 2)[(fq >= f_lo) & (fq < f_hi)].sum())
            pb = float((np.abs(np.fft.rfft(before_st[:, 0])) ** 2)[(fq >= f_lo) & (fq < f_hi)].sum())
            return 10.0 * np.log10((pa + 1e-24) / (pb + 1e-24))

        # amb: <80Hz 大幅切净（110Hz HPF），650-1000Hz 暖中频让出 ~ -2.5..-3.0 dB，高频丝绒感保留
        self.assertLess(band_db_diff(sculpted['amb'], white_st, 35.0, 80.0), -6.5)
        self.assertLess(band_db_diff(sculpted['amb'], white_st, 680.0, 960.0), -2.0)
        self.assertGreater(band_db_diff(sculpted['amb'], white_st, 5000.0, 9000.0), -0.5)
        # foley: <90Hz 高通切除 + 260-400Hz 去闷泥
        self.assertLess(band_db_diff(sculpted['foley'], white_st, 35.0, 90.0), -7.5)
        self.assertLess(band_db_diff(sculpted['foley'], white_st, 260.0, 400.0), -1.6)
        # fx: 保留 65-120Hz 超低频冲击力，削减 230-340Hz 浑浊区
        self.assertGreater(band_db_diff(sculpted['fx'], white_st, 65.0, 120.0), -1.2)
        self.assertLess(band_db_diff(sculpted['fx'], white_st, 230.0, 340.0), -1.5)
        # music: 保留 120-1200Hz 饱满基频和声，仅在 2.8-3.8kHz 轻柔微让位 ~ -1 dB
        self.assertGreater(band_db_diff(sculpted['music'], white_st, 150.0, 1000.0), -0.3)
        self.assertLess(band_db_diff(sculpted['music'], white_st, 2800.0, 3700.0), -0.6)

        # 3) HDRMixer 新默认配比（music_ceiling_offset_db=-2.6, continuous_duck_db=1.8, master_glue=True）
        t = D.T(dur)
        mus_warm = D.stereo(
            0.35 * np.sin(2.0 * np.pi * 146.83 * t)
            + 0.28 * np.sin(2.0 * np.pi * 293.66 * t)
            + 0.25 * D.bp(rng.standard_normal(n), 280.0, 4200.0, 2),
            0.0,
        )
        mx = DR.HDRMixer(dur, fps=24.0, target_lufs=-13.4, max_tp=-1.5)
        mx.add_bed(
            'music', mus_warm, target_lufs=-17.5, how='win',
            curve_points=[(0.0, -0.5), (2.0, 0.0), (4.5, +1.8)],
        )
        mx.add_bed('amb', D.decor_pair(D.pink, n, rng, corr=0.45) * 0.15, target_lufs=-25.0, how='win')
        snap_sfx = 0.85 * np.exp(-D.T(0.20) / 0.045) * D.bp(rng.standard_normal(D.N(0.20)), 1600.0, 6200.0, 2)
        mx.add_cue('sail_snap', snap_sfx, 2.0, role='hero', bus='fx', target_lufs=-15.5)
        wake_sfx = D.bp(rng.standard_normal(D.N(1.8)), 350.0, 5400.0, 2) * 0.35
        mx.add_cue('bow_wake', wake_sfx, 2.3, role='support', bus='fx', target_lufs=-19.5)

        master_st, stems_out, diag = mx.render()
        self.assertAlmostEqual(M.integrated(master_st), -13.4, delta=0.12)
        mus_final_lufs = M.integrated(stems_out['music'])
        # 终混配乐稳立在 -15.2 ~ -18.0 LUFS 黄金区间（绝不被双重压制到 -25 LUFS！）
        self.assertGreaterEqual(mus_final_lufs, -18.0, f'配乐被过度压制: {mus_final_lufs:.2f} LUFS')
        self.assertLessEqual(mus_final_lufs, -14.8, f'配乐过热吞噬净空: {mus_final_lufs:.2f} LUFS')
        self.assertGreaterEqual(diag['glueMaxGrDb'], 1.5)
        self.assertLessEqual(diag['glueMaxGrDb'], 3.25)


if __name__ == '__main__':
    unittest.main()
