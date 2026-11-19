# -*- coding: utf-8 -*-
"""智能剪辑、运动声像贴合与三干线乐效协同工作台 engine/audio/editorial.py 单元测试与 QA 门禁实测。"""
import os
import shutil
import unittest

import numpy as np

import _audiotest as H
from engine.audio import cues as C
from engine.audio import director as DR
from engine.audio import dsp as D
from engine.audio import editorial as ED
from engine.audio import foley as F
from engine.audio import meter as M
from engine.audio import qa as QA


class AudioEditorialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('audio-editorial')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_smart_edit_clip_sustained_trim_shapes_and_stop_transient(self):
        """过程音效精裁：保留前导 anchor，按 visual_dur 裁切，区分 cosine/exp 阻尼斜率，并在停止帧叠入微制动咔嗒。"""
        r = D.rng(17)
        long_fric = D.bp(D.pink(D.N(1.60), r), 500.0, 5200.0, 2) * 0.45

        ed_cos, anc_cos = ED.smart_edit_clip(
            long_fric, 0.40, mode='sustained', anchor=0.05, release_shape='cosine', seed=3
        )
        ed_exp, anc_exp = ED.smart_edit_clip(
            long_fric, 0.40, mode='sustained', anchor=0.05, release_shape='exp', seed=3
        )
        self.assertAlmostEqual(anc_cos, 0.05, places=5)
        self.assertAlmostEqual(anc_exp, 0.05, places=5)
        self.assertEqual(len(ed_cos), D.N(0.45))
        self.assertEqual(len(ed_exp), D.N(0.45))
        self.assertEqual(float(ed_cos[0]), 0.0)
        self.assertEqual(float(ed_cos[-1]), 0.0)
        self.assertEqual(float(ed_exp[-1]), 0.0)

        # 指数阻尼在释放段中前期衰减快于余弦平方阻尼
        tail_slice = slice(D.N(0.38), D.N(0.43))
        self.assertLess(D.rms(ed_exp[tail_slice]), D.rms(ed_cos[tail_slice]) * 0.72)

        # 叠入制动微咔嗒：在动作停止时刻 0.45s 处形成清脆制动峰
        t_clk = D.T(0.022)
        brake_click = 0.75 * np.exp(-t_clk / 0.0022) * D.bp(D.white(len(t_clk), r), 1800.0, 9500.0, 2)
        ed_stop, _ = ED.smart_edit_clip(
            long_fric, 0.40, mode='sustained', anchor=0.05, release_shape='exp', stop_transient=brake_click, seed=3
        )
        stop_zone_with = D.rms(ed_stop[D.N(0.442):min(len(ed_stop), D.N(0.462))])
        stop_zone_plain = D.rms(ed_exp[D.N(0.442):D.N(0.450)])
        self.assertGreater(stop_zone_with, stop_zone_plain * 4.0)

    def test_smart_edit_clip_nonperiodic_extension_and_impulsive_cut_guard(self):
        """短过程音效走非周期交叉淡化延展（显著低于 np.tile 周期自相关）；冲击余韵音效在硬切点前平滑收尾防穿帮。"""
        r = D.rng(29)
        t_short = D.T(0.22)
        short_tex = D.bp(D.pink(len(t_short), r), 420.0, 4800.0, 2) * (0.55 + 0.45 * np.sin(2 * np.pi * 6.0 * t_short))

        ext_a, _ = ED.smart_edit_clip(short_tex, 1.35, mode='sustained', seed=11)
        ext_b, _ = ED.smart_edit_clip(short_tex, 1.35, mode='sustained', seed=11)
        self.assertEqual(len(ext_a), D.N(1.35))
        self.assertTrue(np.allclose(ext_a, ext_b), '相同种子延展必须完全确定')

        # 对比死循环拼接：在原始周期 lag = len(short_tex) 处自相关系数显著更低
        lag = len(short_tex)
        naive_loop = np.resize(short_tex, len(ext_a))

        def lag_corr(sig):
            a = sig[D.N(0.25):-lag] - np.mean(sig[D.N(0.25):-lag])
            b = sig[D.N(0.25) + lag:] - np.mean(sig[D.N(0.25) + lag:])
            return float(abs(np.dot(a, b)) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-20))

        self.assertGreater(lag_corr(naive_loop), 0.95)
        self.assertLess(lag_corr(ext_a), 0.65)

        # 冲击余韵类（如剑鸣 1.2s）：无切点时完整保留长余韵；有 next_cut_in_s=0.38 时在切点前干净收束
        ring_w, ring_anc = F.blade_ring(dur=1.20, f0=1480.0, key='D', seed=5)
        imp_free, anc_free = ED.smart_edit_clip(ring_w, 0.05, mode='impulsive', anchor=ring_anc)
        self.assertEqual(len(imp_free), len(ring_w))
        self.assertAlmostEqual(anc_free, ring_anc, places=4)

        imp_cut, anc_cut = ED.smart_edit_clip(
            ring_w, 0.05, mode='impulsive', anchor=ring_anc, next_cut_in_s=0.38, release_shape='cosine'
        )
        self.assertEqual(len(imp_cut), D.N(anc_cut + 0.38))
        self.assertEqual(float(imp_cut[-1]), 0.0)
        self.assertLess(D.rms(imp_cut[-D.N(0.015):]), D.rms(imp_cut[D.N(0.02):D.N(0.10)]) * 0.12)

    def test_schedule_action_series_combo_ioi_tightening_and_finisher_release(self):
        """快拳连击编排：密间隔 IOI=0.14s 自动收紧前序尾音防浑浊，最后一记重拳完整释放长尾音且相邻绝不复读。"""
        r = D.rng(63)
        t = D.T(0.52)
        punch_take = (
            0.85 * np.exp(-t / 0.018) * np.sin(2 * np.pi * (150.0 * np.exp(-t / 0.012) + 58.0) * t)
            + 0.45 * np.exp(-t / 0.22) * D.lp(D.brown(len(t), r), 220.0, 2)
            + 0.35 * np.exp(-t / 0.008) * D.bp(D.white(len(t), r), 1200.0, 6800.0, 2)
        )
        heavy_accent = 0.70 * np.exp(-t / 0.28) * D.bp(D.pink(len(t), r), 65.0, 1800.0, 2)

        hit_times = [0.20, 0.34, 0.48, 0.62, 0.80]
        forces = [0.48, 0.56, 0.66, 0.78, 1.20]
        series = ED.schedule_action_series(
            hit_times,
            forces=forces,
            takes=[punch_take],
            accent_takes=[heavy_accent],
            policy='anti_fatigue',
            min_tail_s=0.06,
            seed=19,
        )
        self.assertEqual(len(series), 5)

        for prev_it, next_it in zip(series[:-1], series[1:]):
            m_len = min(len(prev_it['wave']), len(next_it['wave']))
            self.assertFalse(np.allclose(prev_it['wave'][:m_len], next_it['wave'][:m_len]))

        for fast_it in series[:-1]:
            self.assertTrue(fast_it['meta']['tailTightened'], fast_it['meta'])
            self.assertFalse(fast_it['meta']['isFinisher'])
            self.assertLessEqual(fast_it['meta']['effectiveTailSec'], 0.16)

        finisher = series[-1]
        self.assertTrue(finisher['meta']['isFinisher'])
        self.assertFalse(finisher['meta']['tailTightened'])
        self.assertTrue(finisher['meta']['accentAdded'])
        self.assertGreater(finisher['meta']['effectiveTailSec'], 0.42)

    def test_couple_motion_trajectory_bee_flyby_pan_doppler_and_shot_cap(self):
        """蜜蜂左→右掠过轨迹：验证声像平滑左→中→右扫掠、掠过中心音量峰、逼近升调/远离降调多普勒、以及微距景别限宽。"""
        dur = 1.20
        t = D.T(dur)
        # 260 Hz 蜜蜂振翅基频 + 谐波簇，便于精确测量多普勒频移与声像能量
        bee_buzz = (
            0.55 * np.sin(2 * np.pi * 260.0 * t)
            + 0.30 * np.sin(2 * np.pi * 520.0 * t)
            + 0.18 * np.sin(2 * np.pi * 1040.0 * t)
        )

        fly_st = ED.couple_motion_trajectory(
            bee_buzz,
            pan_keyframes=[(0.0, -0.85), (dur, 0.85)],
            shot_scale='full',
            poa='open_sky',
            max_speed_mps=24.0,
        )
        self.assertEqual(fly_st.shape, (D.N(dur), 2))

        # 1. 左→中→右连续声像扫掠
        seg_l = fly_st[D.N(0.08):D.N(0.28)]
        seg_c = fly_st[D.N(0.54):D.N(0.66)]
        seg_r = fly_st[D.N(0.92):D.N(1.12)]
        self.assertGreater(D.rms(seg_l[:, 0]), D.rms(seg_l[:, 1]) * 2.2)
        self.assertGreater(D.rms(seg_r[:, 1]), D.rms(seg_r[:, 0]) * 2.2)
        center_skew_db = abs(20.0 * np.log10((D.rms(seg_c[:, 0]) + 1e-12) / (D.rms(seg_c[:, 1]) + 1e-12)))
        self.assertLess(center_skew_db, 2.2)

        # 2. 掠过视觉中心最近点（CPA）音量峰显著高于进出边缘
        e_in = D.rms(fly_st[D.N(0.06):D.N(0.24)])
        e_mid = D.rms(fly_st[D.N(0.48):D.N(0.72)])
        e_out = D.rms(fly_st[D.N(0.96):D.N(1.14)])
        self.assertGreater(e_mid, e_in * 1.45)
        self.assertGreater(e_mid, e_out * 1.35)

        # 3. 径向多普勒频移：前半程逼近主频 > 260 Hz > 后半程远离主频
        def dom_freq(seg_mono):
            win = np.hanning(len(seg_mono))
            sp = np.abs(np.fft.rfft(seg_mono * win))
            fq = np.fft.rfftfreq(len(seg_mono), 1.0 / D.SR)
            band = (fq >= 200.0) & (fq <= 330.0)
            idx_band = np.flatnonzero(band)
            # 抛物线谱峰插值提高频率分辨率
            pk_i = int(idx_band[np.argmax(sp[band])])
            if 0 < pk_i < len(sp) - 1:
                a0, a1, a2 = np.log(sp[pk_i - 1] + 1e-20), np.log(sp[pk_i] + 1e-20), np.log(sp[pk_i + 1] + 1e-20)
                delta = 0.5 * (a0 - a2) / max(abs(a0 - 2 * a1 + a2), 1e-12)
                return float((pk_i + delta) * D.SR / len(seg_mono))
            return float(fq[pk_i])

        f_app = dom_freq(fly_st[D.N(0.12):D.N(0.44)].mean(axis=1))
        f_rec = dom_freq(fly_st[D.N(0.76):D.N(1.08)].mean(axis=1))
        self.assertGreater(f_app, 262.0)
        self.assertLess(f_rec, 258.0)
        self.assertGreater(f_app - f_rec, 8.0)

        # 4. 微距景别 SHOT_PAN_CAP['macro']=0.12 约束：即使轨迹给 ±0.85，左右偏斜仍严格受控
        macro_st = ED.couple_motion_trajectory(
            bee_buzz, pan_keyframes=[(0.0, -0.85), (dur, 0.85)], shot_scale='macro', poa='intimate_dry'
        )
        mac_l = macro_st[D.N(0.08):D.N(0.28)]
        mac_skew_db = abs(20.0 * np.log10((D.rms(mac_l[:, 0]) + 1e-12) / (D.rms(mac_l[:, 1]) + 1e-12)))
        self.assertLess(mac_skew_db, 2.6)

        # 5. 支持 cues.Track（x + depth + speed）连续遥测输入
        tr = C.Track(
            {'x': [0.05, 0.50, 0.95], 'depth': [0.85, 0.10, 0.85], 'speed': [0.4, 1.0, 0.4]},
            fps=2.0,
            dur=1.0,
        )
        tr_st = ED.couple_motion_trajectory(bee_buzz[:D.N(1.0)], track=tr, shot_scale='wide', poa='fog_wide')
        self.assertEqual(tr_st.shape, (D.N(1.0), 2))
        self.assertGreater(D.rms(tr_st[D.N(0.40):D.N(0.60)]), D.rms(tr_st[D.N(0.05):D.N(0.20)]) * 1.35)

        # 6. 远近景深对比：远景（depth=0.95）高频空气吸收更强、混响尾占比（R/D）高于近景（depth=0.05）
        burst = np.zeros(D.N(0.60))
        burst[:D.N(0.08)] = D.white(D.N(0.08), D.rng(41)) * np.exp(-D.T(0.08) / 0.025)
        near_st = ED.couple_motion_trajectory(burst, depth_curve=0.05, poa='open_sky', max_speed_mps=0.0)
        far_st = ED.couple_motion_trajectory(burst, depth_curve=0.95, poa='open_sky', max_speed_mps=0.0)
        sp_near = np.abs(np.fft.rfft(near_st[:D.N(0.10)].mean(axis=1))) ** 2
        sp_far = np.abs(np.fft.rfft(far_st[:D.N(0.10)].mean(axis=1))) ** 2
        fq_b = np.fft.rfftfreq(D.N(0.10), 1.0 / D.SR)
        hf_ratio_near = float(sp_near[fq_b >= 7000.0].sum() / (sp_near.sum() + 1e-20))
        hf_ratio_far = float(sp_far[fq_b >= 7000.0].sum() / (sp_far.sum() + 1e-20))
        self.assertGreater(hf_ratio_near, hf_ratio_far * 2.0)
        tail_to_head_near = D.rms(near_st[D.N(0.16):D.N(0.48)]) / (D.rms(near_st[:D.N(0.08)]) + 1e-12)
        tail_to_head_far = D.rms(far_st[D.N(0.16):D.N(0.48)]) / (D.rms(far_st[:D.N(0.08)]) + 1e-12)
        self.assertGreater(tail_to_head_far, tail_to_head_near * 1.5)

    def test_three_stem_workstation_full_mix_passes_qa_and_world_foley_gate(self):
        """三干线工作台全流程：场景硬切/蒙太奇环境轨 + 音乐主导窗让位 + 调性吸附 + 连击拟音 → 100% 通过 QA 硬门禁与软告警门禁。"""
        r = D.rng(108)
        dur = 8.0
        fps = 24
        nf = int(dur * fps)
        n = D.N(dur)

        ws = ED.ThreeStemWorkstation(dur, fps=fps, world='realistic', target_lufs=-14.0, max_tp=-1.5)

        # 1. 三场环境音：第 72 帧（3.0s）硬切（55ms 微交叉淡化），第 144 帧（6.0s）蒙太奇声桥（0.85s）
        amb_outdoor = D.bp(D.pink(D.N(3.5), r), 350.0, 3800.0, 2) * 0.18
        amb_indoor = D.bp(D.brown(D.N(3.5), r), 90.0, 680.0, 2) * 0.14
        amb_courtyard = D.bp(D.pink(D.N(2.8), r), 220.0, 2600.0, 2) * 0.16
        ws.set_scenes([
            {'in_s': 0.0, 'out_s': 3.0, 'wave': amb_outdoor, 'transition': 'hard_cut'},
            {'in_s': 3.0, 'out_s': 6.0, 'wave': amb_indoor, 'transition': 'montage'},
            {'in_s': 6.0, 'out_s': 8.0, 'wave': amb_courtyard, 'transition': 'hard_cut'},
        ], hard_xfade_s=0.055, montage_xfade_s=0.85, target_lufs=-30.0)

        # 2. D 调配乐，并在 [0.8s, 2.1s] 设为音乐抒情主导窗（自动压低非 hero 音效 -6 dB）
        t = D.T(dur)
        music_pad = (
            0.32 * np.sin(2 * np.pi * 146.83 * t)
            + 0.24 * np.sin(2 * np.pi * 220.00 * t)
            + 0.18 * D.bp(D.pink(n, r), 260.0, 3200.0, 2)
        ) * (0.80 + 0.20 * np.sin(2 * np.pi * 0.35 * t))
        ws.set_music(music_pad, key='D', mode_focus_windows=[(0.80, 2.10, -6.0)], target_lufs=-22.5)

        # 验证音乐主导窗内（1.30s）与窗外（2.45s）相同次要拟音自动压低约 6 dB
        step_clip = 0.65 * np.exp(-D.T(0.09) / 0.018) * D.bp(D.pink(D.N(0.09), r), 250.0, 3400.0, 2)
        e_in = ws.add_foley('step_lyric', step_clip, 1.30, anchor=0.0, pan=-0.10, shot_scale='close', target_lufs=-24.0)
        e_out = ws.add_foley('step_normal', step_clip, 2.45, anchor=0.0, pan=0.10, shot_scale='close', target_lufs=-24.0)
        self.assertAlmostEqual(e_in['musicFocusTrimDb'], -6.0, places=2)
        self.assertAlmostEqual(e_out['musicFocusTrimDb'], 0.0, places=2)

        # 3. 第 96 帧（4.00s）核心动作 hero：偏离音准的 1462 Hz 钟剑声自动吸附 D 五声调式（~1480 Hz），并自动挖负空间与频带让位
        raw_ring, ring_anc = F.blade_ring(dur=0.95, f0=1462.0, key=None, seed=9)
        hero_info = ws.add_sfx(
            'hero_strike',
            raw_ring,
            96 / fps,
            anchor=ring_anc,
            role='hero',
            tonal_hz=1462.0,
            edit_mode='impulsive',
            pan=0.15,
            shot_scale='medium',
            target_lufs=-16.5,
        )
        self.assertAlmostEqual(hero_info['snappedHz'], DR.harmonic_freq(1462.0, root='D', scale='pentatonic'), delta=0.2)

        # 4. 连续拟音连击（5.00..5.62s）与轨迹掠过硬效（6.15..7.05s）+ UI 微提示音（6.80s）
        punch_take = 0.75 * np.exp(-D.T(0.28) / 0.045) * D.bp(D.pink(D.N(0.28), r), 140.0, 4200.0, 2)
        ws.add_foley_series(
            'combo',
            [5.00, 5.14, 5.28, 5.52],
            takes=[punch_take],
            forces=[0.55, 0.65, 0.75, 1.05],
            pan=[-0.12, 0.08, -0.08, 0.14],
            shot_scale='medium',
            target_lufs=-22.5,
            seed=23,
        )
        whoosh_w, _ = F.blade_whoosh(dur=0.55, speed=1.1, seed=31)
        ws.add_sfx(
            'pass_whoosh',
            whoosh_w,
            6.20,
            anchor=0.0,
            role='support',
            span_dur=0.70,
            trajectory={'pan_keyframes': [(0.0, -0.32), (0.70, 0.32)], 'max_speed_mps': 10.0},
            shot_scale='medium',
            poa='fog_wide',
            target_lufs=-21.5,
        )
        beep_w, beep_anc = DR.hitech_micro_beep(freq_hz=1760.0, root='D', pattern='double', dur=0.09, seed=7)
        ws.add_sfx('hud_lock', beep_w, 168 / fps, anchor=beep_anc, role='ui', pan=0.0, target_lufs=-23.5)

        master_st, stems, report = ws.mixdown()
        master_st_2, _, _ = ws.mixdown()
        self.assertTrue(np.allclose(master_st, master_st_2), 'mixdown 多次调用应保持幂等一致')

        # 核验五条标准分轨齐全、母带响度与真峰值严格达标、首尾样本归零
        self.assertEqual(set(stems.keys()), {'amb', 'fx', 'foley', 'ui', 'music'})
        for k, st_arr in stems.items():
            self.assertEqual(st_arr.shape, (n, 2), k)
            self.assertEqual(float(st_arr[0, 0]), 0.0)
            self.assertEqual(float(st_arr[-1, 0]), 0.0)

        self.assertAlmostEqual(M.integrated(master_st), -14.0, delta=0.15)
        tp_db = 20.0 * np.log10(max(M.true_peak(master_st, os=4), 1e-12))
        self.assertLessEqual(tp_db, -1.50)
        self.assertEqual(float(master_st[0].max()), 0.0)
        self.assertEqual(float(master_st[-1].max()), 0.0)
        self.assertIn('step_lyric', report['musicFocusTrimmedIds'])

        # 落盘并实跑 engine.audio.qa 全套硬门禁 + --fail-on-warn 严苛模式（含切点爆音、分轨掩蔽、逐窗平衡）
        fdir = os.path.join(self.td, 'ws-film')
        events = [
            {'id': 'hero_strike', 'frame': 96, 'shot': 'S2', 'audio': 'hero_strike', 'domain': 'sfx', 'bus': 'fx'},
            {'id': 'hud_lock', 'frame': 168, 'shot': 'S3', 'audio': 'hud_lock', 'domain': 'ui', 'bus': 'ui'},
        ]
        H.film_json(
            fdir,
            frames=nf,
            fps=fps,
            cuts=(72, 144),
            events=events,
            audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.5},
        )
        wav_path = C.write(os.path.join(fdir, 'out'), master_st, stems=stems)
        checks, _ = QA.analyze(
            wav_path,
            fps=fps,
            frames=nf,
            cuts=(72, 144),
            target_lufs=-14.0,
            tol_lu=0.5,
            max_tp=-1.5,
            loudness_at='mix',
            film={'fps': fps, 'events': events, 'audio': {}, 'dir': fdir, 'cuts': (72, 144)},
        )
        rep = QA.build_report(checks, profile_id='web-1080p24', fail_on_warn=True)
        self.assertTrue(rep['ok'], rep['checks'])

        cli_res = H.run(['python', '-m', 'engine.audio.qa', '--film', fdir, '--fail-on-warn', '--json'])
        self.assertEqual(cli_res.returncode, 0, cli_res.stdout + '\n' + cli_res.stderr)

        # 验证 world='hitech' 无生命体模式下默认静默抑制 foley 与 foley_series，且支持显式放行
        ws_hi = ED.ThreeStemWorkstation(2.0, fps=24.0, world='hitech')
        ws_hi.set_music(music_pad[:D.N(2.0)], key='D', target_lufs=-20.0)
        sup_res = ws_hi.add_foley('cloth_move', step_clip, 0.5)
        sup_ser = ws_hi.add_foley_series('foot', [0.8, 1.1], takes=[step_clip])
        self.assertTrue(sup_res['suppressed'])
        self.assertEqual(sup_ser, [])
        _, hi_stems, hi_rep = ws_hi.mixdown()
        self.assertEqual(float(np.max(np.abs(hi_stems['foley']))), 0.0)
        self.assertEqual(hi_rep['suppressedFoleyIds'], ['cloth_move', 'foot_0', 'foot_1'])

    def test_screen_ratio_perspective_and_foley_series_force_crescendo(self):
        """验证 couple_motion_trajectory 与 ThreeStemWorkstation 的 screen_ratio 远近纵深，以及 add_foley_series 力度渐强保留。"""
        r = D.rng(311)
        tram_tex = D.bp(D.pink(D.N(1.6), r), 140.0, 8200.0, 2) * 0.42

        # 1. couple_motion_trajectory 支持标量与关键帧 screen_ratio：远去轨迹首段显著响且高频更丰富
        far_st = ED.couple_motion_trajectory(tram_tex, screen_ratio=1.0 / 12.0, poa='open_sky', max_speed_mps=0.0)
        near_st = ED.couple_motion_trajectory(tram_tex, screen_ratio=0.45, poa='open_sky', max_speed_mps=0.0)
        ratio_db = 20.0 * np.log10((D.rms(near_st) + 1e-12) / (D.rms(far_st) + 1e-12))
        self.assertGreater(ratio_db, 9.5)

        recede_st = ED.couple_motion_trajectory(
            tram_tex,
            dur=2.2,
            pan_keyframes=[(0.0, 0.15), (2.2, 0.72)],
            screen_ratio=[(0.0, 0.45), (2.2, 1.0 / 12.0)],
            shot_scale='full',
            poa='open_sky',
            max_speed_mps=8.0,
        )
        head_rms = D.rms(recede_st[D.N(0.05):D.N(0.40)])
        tail_rms = D.rms(recede_st[D.N(1.75):D.N(2.10)])
        self.assertGreater(20.0 * np.log10((head_rms + 1e-12) / (tail_rms + 1e-12)), 8.5)

        # 2. ThreeStemWorkstation 跨镜头 S1(1/12) vs S2(0.45) 远近对比 + 坐姿稳蹬→站起猛蹬力度递进不被抹平
        ws = ED.ThreeStemWorkstation(6.0, fps=24.0, world='semi_realistic')
        ws.add_sfx('tram_s1', tram_tex[:D.N(0.8)], 0.3, anchor=0.0, screen_ratio=1.0 / 12.0, role='support', bus='fx')
        ws.add_sfx('tram_s2', tram_tex[:D.N(0.8)], 1.6, anchor=0.0, screen_ratio=0.45, role='support', bus='fx')

        pedal_take = 0.65 * np.exp(-D.T(0.14) / 0.032) * D.bp(D.pink(D.N(0.14), r), 180.0, 5200.0, 2)
        ws.add_foley_series(
            'pedal',
            [3.00, 3.35, 4.10, 4.35],
            takes=[pedal_take],
            forces=[0.50, 0.54, 1.18, 1.26],
            pan=-0.12,
            shot_scale='medium',
            poa='intimate_dry',
            seed=41,
        )
        _, stems, _ = ws.mixdown()
        s1_rms = D.rms(stems['fx'][D.N(0.35):D.N(1.00)])
        s2_rms = D.rms(stems['fx'][D.N(1.65):D.N(2.30)])
        self.assertGreater(20.0 * np.log10((s2_rms + 1e-12) / (s1_rms + 1e-12)), 9.5)

        sit_rms = D.rms(stems['foley'][D.N(2.98):D.N(3.55)])
        sprint_rms = D.rms(stems['foley'][D.N(4.08):D.N(4.60)])
        self.assertGreater(20.0 * np.log10((sprint_rms + 1e-12) / (sit_rms + 1e-12)), 3.2)

    def test_build_layered_ambience_three_layers_and_music_headroom_qa(self):
        """验证三层复合环境声合成（都市底噪+海浪+海鸥点缀）与新版工作台配乐净空 100% 过严苛 QA 门。"""
        r = D.rng(509)
        dur = 6.0
        n = D.N(dur)

        city_hum = D.bp(D.brown(D.N(2.2), r), 65.0, 900.0, 2) * 0.25
        ocean_surf = D.bp(D.pink(D.N(2.8), r), 120.0, 6200.0, 2) * (0.65 + 0.35 * np.sin(2 * np.pi * 0.32 * D.T(2.8)))
        gull_call = 0.70 * np.exp(-D.T(0.28) / 0.09) * np.sin(2 * np.pi * (1680.0 - 320.0 * D.T(0.28)) * D.T(0.28))

        amb_explicit = ED.build_layered_ambience(
            dur,
            base_bed=city_hum,
            texture_bed=ocean_surf,
            spot_events=[
                {'wave': gull_call, 't': 1.10, 'pan': -0.34, 'screen_ratio': 0.09, 'gain_db': 1.5},
                {'wave': gull_call, 't': 3.40, 'pan': +0.36, 'screen_ratio': 0.07, 'gain_db': 0.5},
            ],
            target_lufs=-29.5,
            seed=7,
        )
        self.assertEqual(amb_explicit.shape, (n, 2))
        self.assertEqual(float(amb_explicit[0].max()), 0.0)
        self.assertEqual(float(amb_explicit[-1].max()), 0.0)
        # 1.10s 左上方海鸥与 3.40s 右上方海鸥分别在各自方位形成清晰生机特征
        g1 = amb_explicit[D.N(1.08):D.N(1.36)]
        g2 = amb_explicit[D.N(3.38):D.N(3.66)]
        self.assertGreater(D.rms(D.bp(g1[:, 0], 1100.0, 2200.0, 2)), D.rms(D.bp(g1[:, 1], 1100.0, 2200.0, 2)) * 1.15)
        self.assertGreater(D.rms(D.bp(g2[:, 1], 1100.0, 2200.0, 2)), D.rms(D.bp(g2[:, 0], 1100.0, 2200.0, 2)) * 1.15)

        # 同时支持直接传入波形列表自动错落排布间歇点缀
        amb_auto = ED.build_layered_ambience(dur, base_bed=city_hum, texture_bed=ocean_surf, spot_events=[gull_call], seed=9)
        self.assertEqual(amb_auto.shape, (n, 2))

        # 接入 ThreeStemWorkstation：即使传入 -16.0 LUFS 强配乐，叙事段自动留出净空、片尾 focus 窗上扬，且过 --fail-on-warn
        ws = ED.ThreeStemWorkstation(dur, fps=24.0, world='semi_realistic', target_lufs=-14.0, max_tp=-1.5)
        ws.set_scenes([{'in_s': 0.0, 'out_s': dur, 'wave': amb_explicit, 'transition': 'hard_cut'}], target_lufs=-29.5)
        music_hot = H.music_like(dur, seed=13)
        ws.set_music(music_hot, key='D', music_focus_windows=[(4.6, 6.0)], target_lufs=-16.0)

        bell_w = 0.8 * np.exp(-D.T(0.24) / 0.06) * np.sin(2 * np.pi * 1760.0 * D.T(0.24))
        ws.add_sfx('bike_bell', bell_w, 2.0, anchor=0.0, role='hero', bus='fx', pan=-0.15, screen_ratio=0.45, target_lufs=-16.0)
        chain_w = D.bp(D.pink(D.N(1.5), r), 350.0, 6500.0, 2) * 0.45
        ws.add_foley('bike_chain', chain_w, 0.8, anchor=0.0, span_dur=1.5, screen_ratio=0.45, target_lufs=-20.5)

        master_st, stems, rep_ws = ws.mixdown()
        mus_narr_lufs = M.integrated(stems['music'][:D.N(4.3)])
        self.assertLessEqual(mus_narr_lufs, -16.0)
        self.assertGreaterEqual(mus_narr_lufs, -19.5)
        self.assertLess(rep_ws['musicNarrativeTrimDb'], -0.5)

        fdir = os.path.join(self.td, 'ws-layered-coastal')
        events = [{'id': 'bike_bell', 'frame': 48, 'shot': 'S1', 'audio': 'bike_bell', 'domain': 'sfx', 'bus': 'fx', 'role': 'hero'}]
        H.film_json(fdir, frames=int(dur * 24), fps=24, cuts=(), events=events,
                    audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.5})
        wav_p = C.write(os.path.join(fdir, 'out'), master_st, stems=stems)
        checks, _ = QA.analyze(wav_p, fps=24, frames=int(dur * 24), cuts=(), target_lufs=-14.0, tol_lu=0.5, max_tp=-1.5,
                               loudness_at='mix', film={'fps': 24, 'events': events, 'audio': {}, 'dir': fdir, 'cuts': ()})
        qa_rep = QA.build_report(checks, profile_id='web-1080p24', fail_on_warn=True)
        self.assertTrue(qa_rep['ok'], qa_rep['checks'])

    def test_workstation_fader_curves_complementary_eq_and_master_glue(self):
        """验证 ThreeStemWorkstation 推子音量曲线（set_music / set_scenes curve_points）、互补 EQ 分槽与 -13.3 LUFS 总线粘合母带闭环。"""
        r = D.rng(717)
        dur = 8.0
        fps = 24

        ws = ED.ThreeStemWorkstation(
            dur,
            fps=fps,
            world='semi_realistic',
            target_lufs=-13.3,
            max_tp=-1.5,
            glue_eq=True,
            master_glue=True,
        )

        # 环境音随终章拉远平滑收低 -5 dB（给管弦终章腾出温暖空间）
        amb_wave = ED.build_layered_ambience(
            dur,
            base_bed=D.bp(D.brown(D.N(2.5), r), 60.0, 900.0, 2) * 0.22,
            texture_bed=D.bp(D.pink(D.N(2.8), r), 150.0, 6000.0, 2) * 0.30,
            target_lufs=-24.0,
            seed=12,
        )
        ws.set_scenes(
            [{'in_s': 0.0, 'out_s': dur, 'wave': amb_wave, 'transition': 'hard_cut'}],
            target_lufs=-23.0,
            curve_points=[(0.0, 0.0), (4.5, -1.0), (6.5, -5.0), (8.0, -5.5)],
        )

        # 配乐在 1.4s 雷击瞬间微呼吸避让 -2.5 dB 后回升，并在 5.5-8.0s 推向全片高潮 +2.6 dB
        music_score = H.music_like(dur, seed=29)
        ws.set_music(
            music_score,
            key='D',
            target_lufs=-17.5,
            curve_points=[(0.0, -0.5), (1.2, 0.0), (1.45, -2.5), (1.80, 0.0), (5.2, +1.2), (6.8, +2.6), (8.0, +2.4)],
            music_focus_windows=[(6.2, 8.0, 2.2)],
        )

        thunder_hit = 0.85 * np.exp(-D.T(0.45) / 0.14) * D.bp(D.brown(D.N(0.45), r), 60.0, 3200.0, 2)
        thunder_hit[:D.N(0.08)] += 0.65 * np.exp(-D.T(0.08) / 0.02) * D.bp(D.white(D.N(0.08), r), 1800.0, 6500.0, 2)
        ws.add_sfx('thunder_clap', thunder_hit, 1.45, anchor=0.0, role='hero', bus='fx', target_lufs=-15.5)

        lantern_pop = 0.80 * np.exp(-D.T(0.18) / 0.045) * D.bp(D.pink(D.N(0.18), r), 1400.0, 5800.0, 2)
        ws.add_sfx('lantern_pop', lantern_pop, 3.50, anchor=0.0, role='support', bus='fx', target_lufs=-16.5)

        bow_wake = D.bp(D.pink(D.N(2.4), r), 320.0, 5400.0, 2) * 0.42
        ws.add_sfx('bow_wake', bow_wake, 3.80, anchor=0.0, span_dur=2.2, role='support', bus='fx', target_lufs=-17.5)

        cloth_take = 0.65 * np.exp(-D.T(0.22) / 0.06) * D.bp(D.pink(D.N(0.22), r), 180.0, 4800.0, 2)
        ws.add_foley('pole_raise', cloth_take, 3.10, anchor=0.0, target_lufs=-20.5)

        master_st, stems, rep = ws.mixdown()
        self.assertAlmostEqual(M.integrated(master_st), -13.3, delta=0.15)
        self.assertLessEqual(rep['truePeakDbtp'], -1.50)
        self.assertGreaterEqual(rep['glueMaxGrDb'], 1.5)
        self.assertLessEqual(rep['glueMaxGrDb'], 3.25)

        # 验证配乐稳立在黄金区间（-15.2 ~ -18.0 LUFS），与音效平起平坐且绝无 music_buried
        mus_lufs = M.integrated(stems['music'])
        self.assertGreaterEqual(mus_lufs, -18.0, f'配乐过弱: {mus_lufs:.2f} LUFS')
        self.assertLessEqual(mus_lufs, -15.0, f'配乐过强: {mus_lufs:.2f} LUFS')

        # 验证音量曲线生效：环境音尾段较前段明显收低，配乐尾段高潮较前段明显推高
        amb_early = D.rms(stems['amb'][D.N(0.5):D.N(2.5)])
        amb_late = D.rms(stems['amb'][D.N(6.6):D.N(7.7)])
        self.assertLess(20.0 * np.log10((amb_late + 1e-12) / (amb_early + 1e-12)), -3.0)

        mus_dip = D.rms(stems['music'][D.N(1.38):D.N(1.62)])
        mus_climax = D.rms(stems['music'][D.N(6.5):D.N(7.6)])
        self.assertGreater(20.0 * np.log10((mus_climax + 1e-12) / (mus_dip + 1e-12)), 2.5)

        # 落盘过 engine.audio.qa --fail-on-warn（targetLUFS=-13.3，双向乐效守卫零告警）
        fdir = os.path.join(self.td, 'ws-glue-curve')
        events = [
            {'id': 'thunder_clap', 'frame': int(round(1.45 * fps)), 'shot': 'S1', 'audio': 'thunder_clap', 'domain': 'sfx', 'bus': 'fx', 'role': 'hero'},
            {'id': 'lantern_pop', 'frame': int(round(3.50 * fps)), 'shot': 'S1', 'audio': 'lantern_pop', 'domain': 'sfx', 'bus': 'fx'},
        ]
        H.film_json(
            fdir,
            frames=int(dur * fps),
            fps=fps,
            cuts=(),
            events=events,
            audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -13.3, 'truePeakDbTP': -1.5},
        )
        wav_p = C.write(os.path.join(fdir, 'out'), master_st, stems=stems)
        checks, _ = QA.analyze(
            wav_p, fps=fps, frames=int(dur * fps), cuts=(), target_lufs=-13.3, tol_lu=0.5, max_tp=-1.5,
            loudness_at='mix', film={'fps': fps, 'events': events, 'audio': {}, 'dir': fdir, 'cuts': ()},
        )
        qa_rep = QA.build_report(checks, profile_id='web-1080p24', fail_on_warn=True)
        self.assertTrue(qa_rep['ok'], qa_rep['checks'])


if __name__ == '__main__':
    unittest.main()
