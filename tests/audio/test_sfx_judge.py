# -*- coding: utf-8 -*-
"""音效物理形态与录音取证判定器 engine/audio/sfx_judge.py 单元测试（Stage 1 零训练判据）。"""
import os
import shutil
import unittest

import numpy as np

import _audiotest as H
from engine.audio import dsp as D
from engine.audio import mixing as MX
from engine.audio import sfx_judge as J


class SfxJudgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('sfx-judge')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_clean_cloth_friction_passes_with_low_rumble_whitening(self):
        rng = np.random.default_rng(101)
        dur = 0.42
        n = D.N(dur)
        t = np.arange(n) / D.SR
        env = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 1.25
        # 真实织物摩擦既有高频纤维湍流，也常带近讲低频隆隆声；白化自相关不应误报为周期谐波
        fibers = D.hp(D.lp(rng.standard_normal(n), 11500.0, 2), 950.0, 2) * 0.35
        rumble = D.lp(rng.standard_normal(n), 140.0, 2) * 0.45
        wave = (fibers + rumble) * env
        res = J.judge_wave(wave, D.SR, 'friction_cloth')
        self.assertTrue(res['ok'], res)
        self.assertEqual(res['status'], 'pass', res)
        self.assertLess(res['metrics']['pitch_prominence'], 0.35)
        self.assertGreater(res['metrics']['log_attack_time'], -1.85)

    def test_h1_mechanical_snap_rejected_for_cloth(self):
        rng = np.random.default_rng(102)
        n = D.N(0.35)
        wave = rng.standard_normal(n) * 0.015
        # H1 混淆物：孤立亚毫秒机械硬刺（LAT < -2.3，波峰因数 > 28 dB）
        i0 = D.N(0.06)
        decay = np.exp(-np.arange(D.N(0.008)) / (D.SR * 0.0009))
        wave[i0:i0 + len(decay)] += 0.92 * decay * rng.choice([-1.0, 1.0], size=len(decay))
        res = J.judge_wave(wave, D.SR, 'friction_cloth')
        self.assertFalse(res['ok'], res)
        self.assertEqual(res['status'], 'reject', res)
        self.assertLess(res['metrics']['log_attack_time'], -2.1)

    def test_vocal_or_synth_harmonic_comb_rejected_for_whoosh(self):
        dur = 0.45
        n = D.N(dur)
        t = np.arange(n) / D.SR
        env = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 1.3
        # 合成器/口技周期脉冲列（210→250 Hz 扫频谐波梳）冒充破空声
        f0 = 210.0 + 40.0 * (t / dur)
        phase = 2.0 * np.pi * np.cumsum(f0) / D.SR
        synth = sum((1.0 / k) * np.sin(k * phase) for k in range(1, 22))
        synth = synth / (np.max(np.abs(synth)) + 1e-9) * 0.65 * env
        res = J.judge_wave(synth, D.SR, 'whoosh')
        self.assertFalse(res['ok'], res)
        self.assertEqual(res['status'], 'reject', res)
        self.assertGreater(res['metrics']['pitch_prominence'], 0.55)

    def test_fake_upsampled_narrow_bandwidth_and_clipping_rejected(self):
        rng = np.random.default_rng(104)
        n = D.N(0.30)
        # 8 kHz 电话音质闷糊素材转存 48 kHz：95% 能量不到 1.5 kHz
        muffled = D.lp(rng.standard_normal(n), 1100.0, 4) * np.hanning(n) * 0.5
        r_bw = J.judge_wave(muffled, D.SR, 'water')
        self.assertEqual(r_bw['status'], 'reject', r_bw)
        self.assertLess(r_bw['metrics']['bandwidth_95_hz'], 2000.0)

        # 削波过载
        clipped = np.clip(rng.standard_normal(n) * 1.4, -1.0, 1.0)
        r_clip = J.judge_wave(clipped, D.SR, 'impact')
        self.assertEqual(r_clip['status'], 'reject', r_clip)
        self.assertGreaterEqual(r_clip['metrics']['clipped_samples'], 24)

    def test_sustained_bed_and_low_drone_no_false_reverb_while_hall_tail_caught(self):
        """持续风声/长音不应被 Schroeder 积分误判为超长混响；而脉冲敲击带 2.4s 大堂混响尾音应准确检出 rt20_s。"""
        rng = np.random.default_rng(106)
        # 1) 2.2s 持续海风：不应产生假 RT20
        n_bed = D.N(2.2)
        breeze = D.hp(D.lp(rng.standard_normal(n_bed), 3200.0, 2), 120.0, 2) * 0.25
        r_breeze = J.judge_wave(breeze, D.SR, J.infer_archetype('breeze'))
        self.assertEqual(r_breeze['archetype'], 'ambience')
        self.assertIsNone(r_breeze['metrics']['rt20_s'])
        self.assertEqual(r_breeze['status'], 'pass', r_breeze)

        # 2) 刻意设计的超低频气压体感（lp=400 清单意图）：不应误判为伪高采样率电话音质
        sub = D.lp(rng.standard_normal(D.N(1.6)), 280.0, 3) * np.hanning(D.N(1.6)) * 0.4
        r_sub = J.judge_wave(sub, D.SR, 'generic', spec={'lp': 400})
        self.assertEqual(r_sub['archetype'], 'low_drone')
        self.assertEqual(r_sub['status'], 'pass', r_sub)

        # 3) 近景木击混入长混响尾音（等效 RT60 ≈ 2.4s → RT20 ≈ 0.80s > wood 上限 0.45*1.6=0.72s）：准确标 suspect
        n_hit = D.N(2.0)
        t = np.arange(n_hit) / D.SR
        click = D.bp(rng.standard_normal(D.N(0.015)), 800.0, 6500.0, 2) * np.exp(-np.arange(D.N(0.015)) / (D.SR * 0.0025))
        hall_tail = D.bp(rng.standard_normal(n_hit), 500.0, 5200.0, 2) * 0.16 * np.exp(-t / 0.35)
        hall_hit = hall_tail.copy()
        hall_hit[:len(click)] += click * 0.85
        r_hall = J.judge_wave(hall_hit, D.SR, 'wood')
        self.assertIsNotNone(r_hall['metrics']['rt20_s'])
        self.assertGreater(r_hall['metrics']['rt20_s'], 0.72)
        self.assertEqual(r_hall['status'], 'suspect', r_hall)

    def test_multi_flap_foley_snap_measures_single_slice_attack(self):
        """多下连续扑翼素材（如鸽群起飞）：按独立短事件切片测起音，不把整串间隔误判为慢起音。"""
        rng = np.random.default_rng(107)
        n = D.N(0.85)
        wave = np.zeros(n)
        for at in (0.08, 0.24, 0.41, 0.59):
            i0 = D.N(at)
            m = D.N(0.045)
            tt = np.arange(m) / D.SR
            flap = D.bp(rng.standard_normal(m), 900.0, 7500.0, 2) * np.minimum(1.0, tt / 0.004) * np.exp(-tt / 0.014)
            wave[i0:i0 + m] += flap * 0.6
        r = J.judge_wave(wave, D.SR, J.infer_archetype('pigeons'))
        self.assertEqual(r['archetype'], 'foley_snap')
        self.assertEqual(r['status'], 'pass', r)

    def test_cli_json_envelope_and_exit_code(self):
        rng = np.random.default_rng(105)
        d_ok = os.path.join(self.td, 'ok')
        os.makedirs(d_ok, exist_ok=True)
        n = D.N(0.36)
        t = np.arange(n) / D.SR
        good = D.hp(D.lp(rng.standard_normal(n), 12000.0, 2), 900.0, 2) * (np.sin(np.pi * t / 0.36) ** 1.2) * 0.45
        H.write_wav(os.path.join(d_ok, 'robe_clean.wav'), MX.stereo(good))

        r1 = H.run(['python', '-m', 'engine.audio.sfx_judge', d_ok, '--json'])
        env1 = H.envelope(r1)
        self.assertEqual(r1.returncode, 0, r1.stderr[-800:])
        self.assertTrue(env1['ok'])

        d_bad = os.path.join(self.td, 'bad')
        os.makedirs(d_bad, exist_ok=True)
        bad = np.clip(rng.standard_normal(n) * 1.6, -1.0, 1.0)
        H.write_wav(os.path.join(d_bad, 'cloth_clipped.wav'), MX.stereo(bad))
        r2 = H.run(['python', '-m', 'engine.audio.sfx_judge', d_bad, '--json'])
        env2 = H.envelope(r2)
        self.assertEqual(r2.returncode, 4)
        self.assertEqual(env2['error']['code'], 'contract.sfx-judge')

    def test_mechanical_multi_click_and_public_cc0_html_parser(self):
        """圆珠笔多下连续按压（单下仅 6ms）归入 mechanical 原型后按单下切片评测，不误报房间长混响；fetch_sfx 公开 HTML 解析过滤禁标。"""
        from tools import fetch_sfx as FS
        rng = np.random.default_rng(109)
        seq = np.zeros(D.N(1.6))
        for at in (0.10, 0.35, 0.68, 0.96, 1.30):
            i0 = D.N(at)
            m = D.N(0.006)
            seq[i0:i0 + m] += D.bp(rng.standard_normal(m), 1400.0, 12000.0, 2) * np.exp(-np.arange(m) / (D.SR * 0.0014)) * 0.8
        res = J.judge_wave(seq, D.SR, J.infer_archetype('ballpoint_pen_click'))
        self.assertEqual(res['archetype'], 'mechanical')
        self.assertEqual(res['status'], 'pass', res)

        sample_html = '''
        <div class="bw-player" data-sound-id="499190" data-username="famu" data-ogg="https://cdn.freesound.org/previews/499/499190_1-lq.ogg"
             data-title="15_ballpoint pen, click.WAV" data-duration="14.0" data-samplerate="48000.0"></div>
        <div class="bw-player__tags-list-height"><a href="/browse/tags/foley/">foley</a></div>
        <div class="bw-player" data-sound-id="999999" data-username="bad" data-ogg="https://cdn.freesound.org/previews/999/999999_1-lq.ogg"
             data-title="8bit synth laser.wav" data-duration="1.2" data-samplerate="44100.0"></div>
        <div class="bw-player__tags-list-height"><a href="/browse/tags/synth/">synth</a></div>
        '''
        parsed = FS.parse_public_search_html(sample_html)
        self.assertEqual(len(parsed), 2)
        self.assertTrue(parsed[0]['previews']['preview-hq-ogg'].endswith('-hq.ogg'))
        self.assertGreater(FS.human_score(parsed[0]), 0.0)
        self.assertLess(FS.human_score(parsed[1]), 0.0)

    def test_ontology_guard_and_clean_gain_slice_loader(self):
        """因果本体守卫与洁净增益门禁：舵机归入 motorized、持续电机正弦被 judge_ontology 拒绝、低 raw_pk 高噪切片被 load_slice 拦截。"""
        from engine.audio import library as L
        self.assertEqual(J.infer_archetype('micro_servo_zoom_lens'), 'motorized')
        self.assertEqual(J.infer_archetype('nikon_shutter_dial'), 'mechanical')

        rng = np.random.default_rng(203)
        t = np.arange(D.N(0.45)) / D.SR
        motor_hum = 0.45 * np.sin(2.0 * np.pi * 420.0 * t) + 0.03 * rng.standard_normal(len(t))
        r_hum = J.judge_ontology(motor_hum, D.SR, power='passive', name='pen_mechanism')
        self.assertEqual(r_hum['status'], 'reject', r_hum)
        self.assertGreater(r_hum['metrics']['sustained_tone_ms'], 120.0)

        clean_click = np.zeros(D.N(0.30))
        clean_click[D.N(0.05):D.N(0.065)] = D.bp(rng.standard_normal(D.N(0.015)), 1800.0, 11000.0, 2) * 0.65
        clean_click += 1e-4 * rng.standard_normal(len(clean_click))
        seg_ok, info_ok = L.load_slice(clean_click, 0.02, 0.14, max_gain_db=20.0, on_fail='none')
        self.assertIsNotNone(seg_ok)
        self.assertTrue(info_ok['ok'], info_ok)
        # 截取静止底噪段（raw_pk ≈ 0.0004）：所需增益 > +60 dB，必须被洁净增益门禁拦截
        seg_bad, info_bad = L.load_slice(clean_click, 0.18, 0.28, max_gain_db=20.0, on_fail='none')
        self.assertIsNone(seg_bad)
        self.assertFalse(info_bad['ok'])


if __name__ == '__main__':
    unittest.main()
