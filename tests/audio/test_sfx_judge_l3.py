# -*- coding: utf-8 -*-
"""L3 纯 CPU 物理取证（B1 数字咔嗒 / B3 奈奎斯特折叠混叠 / B4 2–8 kHz 去包络峭度）与不可翻转契约单元测试。"""
import os
import subprocess
import sys
import unittest

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, hilbert, resample_poly, sosfiltfilt

import _audiotest as H
from engine.audio import dsp as D
from engine.audio import procedural as P
from engine.audio import sfx_judge as J


def _crisp_cut(dur: float = 0.16, seed: int = 11) -> np.ndarray:
    """带非高斯微脆裂爆发的宽带剪纸/碎裂测试信号（B4 峭度 > 3.5，B1/B3 干净）。"""
    r = np.random.default_rng(seed)
    n = D.N(dur)
    t = np.arange(n) / float(D.SR)
    env = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 1.2
    micro = 0.25 + 2.4 * (np.abs(D.lp(r.standard_normal(n), 380.0, 2)) ** 2.4)
    w = D.bp(r.standard_normal(n) * micro, 1400.0, 14500.0, 2) * env
    # 前段急促瞬态满足 foley_snap 起音时间约束
    onset_n = D.N(0.012)
    i0 = D.N(0.025)
    w[i0:i0 + onset_n] += D.bp(r.standard_normal(onset_n), 2000.0, 13000.0, 2) * np.exp(-np.arange(onset_n) / (D.SR * 0.002)) * 2.2
    pk = float(np.max(np.abs(w)))
    return D.fade(w / max(pk, 1e-9) * 0.65, 0.002, 0.006)


class L3ForensicsTests(unittest.TestCase):
    def test_b1_digital_click_detects_mono_and_single_channel_stereo_without_false_positive(self):
        clean = _crisp_cut(0.18, seed=1)
        b1_clean = J.detect_digital_click(clean, D.SR)
        self.assertFalse(b1_clean['hit'], b1_clean)
        self.assertLess(b1_clean['max_ratio'], 18.0)

        # 合法剪纸与合法低电平环境留白均不得触发 B1
        shear_w, _ = P.shearing_cut(0.090, material='xuan_paper', stroke='full', seed=4)
        self.assertFalse(J.detect_digital_click(shear_w, D.SR)['hit'])

        r = np.random.default_rng(2)
        silence_bed = D.lp(D.hp(r.standard_normal(D.N(0.5)), 80.0, 2), 4000.0, 2) * 3e-5
        self.assertFalse(J.detect_digital_click(silence_bed, D.SR)['hit'])

        # 1) 单声道注入单样本数字咔嗒
        clicked = clean.copy()
        mid = len(clicked) // 2
        clicked[mid] += 0.65
        clicked[mid + 1] -= 0.12
        b1_hit = J.detect_digital_click(clicked, D.SR)
        self.assertTrue(b1_hit['hit'], b1_hit)
        self.assertGreater(b1_hit['max_ratio'], 18.0)
        self.assertGreaterEqual(b1_hit['events'], 1)

        jg = J.judge_wave(clicked, D.SR, 'foley_snap')
        self.assertFalse(jg['ok'])
        self.assertEqual(jg['status'], 'reject')
        self.assertTrue(jg['physics_hard_fail'])
        self.assertFalse(jg['flippable'])
        self.assertTrue(any('数字咔嗒' in r for r in jg['reasons']), jg['reasons'])

        # 2) 立体声仅右声道注入相反方向毛刺（验证逐声道检验不被声道平均抵消）
        st_click = np.column_stack([clean, clean.copy()])
        st_click[mid, 1] += 0.62
        st_click[mid + 1, 1] -= 0.10
        jg_st = J.judge_wave(st_click, D.SR, 'foley_snap')
        self.assertEqual(jg_st['status'], 'reject', jg_st)
        self.assertTrue(jg_st['forensics']['b1_click']['hit'])

    def test_b3_nyquist_alias_catches_zoh_and_linear_and_complements_bw95(self):
        clean = _crisp_cut(0.24, seed=7)
        b3_clean = J.detect_nyquist_alias(clean, D.SR)
        self.assertFalse(b3_clean['hit'], b3_clean)
        self.assertTrue(J.judge_wave(clean, D.SR, 'foley_snap')['ok'])

        # ZOH16 (48k→16k→48k)、ZOH24 (48k→24k→48k)、Lin16 (48k→16k→48k 线性插值)
        zoh16 = np.repeat(clean[::3], 3)[:len(clean)]
        zoh24 = np.repeat(clean[::2], 2)[:len(clean)]
        dec3 = clean[::3]
        lin16 = np.interp(np.arange(len(clean)) / 3.0, np.arange(len(dec3)), dec3)

        for label, bad in (('zoh16', zoh16), ('zoh24', zoh24), ('lin16', lin16)):
            with self.subTest(kind=label):
                r_b3 = J.detect_nyquist_alias(bad, D.SR)
                self.assertTrue(r_b3['hit'], f'{label} 未被 B3 检出: {r_b3}')
                self.assertGreater(r_b3['mirror_corr'], 0.55)
                jg = J.judge_wave(bad, D.SR, 'foley_snap')
                self.assertEqual(jg['status'], 'reject', jg)
                self.assertTrue(jg['physics_hard_fail'])
                self.assertFalse(jg['flippable'])
                self.assertTrue(any('奈奎斯特折叠混叠' in r for r in jg['reasons']), jg['reasons'])

        # 互补对照：严格多相抗混叠降采样升频（12 kHz）无镜像峰，B3 不负责此项，而由 bandwidth_95_hz 守门
        dec4 = clean[::4] * 4.0
        poly12 = resample_poly(dec4, 4, 1)[:len(clean)]
        poly12 = poly12 / max(1e-9, float(np.max(np.abs(poly12)))) * 0.65
        jg_poly = J.judge_wave(poly12, D.SR, 'foley_snap')
        self.assertLess(jg_poly['metrics']['bandwidth_95_hz'], 6200.0)
        self.assertFalse(jg_poly['forensics']['b3_alias']['hit'])

        # 稀疏纯正弦对称泛音和弦（1600 / 6400 / 9600 Hz）偶发对称于 8000 Hz 折返轴，因无连续折叠谱不被 B3 误判
        t_ui = np.arange(D.N(0.32)) / float(D.SR)
        env_ui = np.minimum(1.0, t_ui / 0.006) * np.exp(-t_ui / 0.085)
        ui_chime = (
            0.55 * np.sin(2.0 * np.pi * 1600.0 * t_ui)
            + 0.32 * np.sin(2.0 * np.pi * 6400.0 * t_ui)
            + 0.22 * np.sin(2.0 * np.pi * 9600.0 * t_ui)
        ) * env_ui
        b3_ui = J.detect_nyquist_alias(ui_chime, D.SR)
        self.assertFalse(b3_ui['hit'], b3_ui)
        self.assertEqual(b3_ui['note'], 'sparse_tonal_hf', b3_ui)
        self.assertEqual(J.judge_wave(ui_chime, D.SR, 'tonal_ui')['status'], 'pass')

        # 低采样率与过短守卫
        self.assertEqual(J.detect_nyquist_alias(clean[:512], D.SR)['note'], 'too_short_or_low_sr')
        self.assertEqual(J.detect_nyquist_alias(clean[:4000], 16000)['note'], 'too_short_or_low_sr')

    def test_b4_deenv_kurtosis_bounds_archetype_gating_and_suspect_band(self):
        rng = np.random.default_rng(202611)
        n = D.N(0.32)
        t = np.arange(n) / float(D.SR)
        env = np.sin(np.pi * t / 0.32) ** 1.1
        sos = butter(4, [1200.0 / (D.SR / 2.0), 14000.0 / (D.SR / 2.0)], btype='bandpass', output='sos')

        # 1) 强平坦高斯白噪（峭度 < 2.9 或接近 3.0）在非适用原型下必须完全豁免
        gauss_flat = sosfiltfilt(sos, rng.standard_normal(n)) * (0.3 + 0.7 * env)
        gauss_flat = gauss_flat / max(1e-9, float(np.max(np.abs(gauss_flat)))) * 0.55
        exempt_archs = (
            'ambience', 'low_drone', 'sustained_tonal', 'tonal_ui',
            'metal_blade', 'motorized', 'mechanical', 'water', 'whoosh', 'generic',
        )
        for arch in exempt_archs:
            b4_ex = J.measure_deenv_kurtosis(gauss_flat, D.SR, archetype=arch)
            self.assertTrue(b4_ex['exempt'], arch)
            self.assertEqual(b4_ex['status'], 'exempt', arch)
            self.assertFalse(b4_ex['hit'], arch)
            self.assertFalse(b4_ex['suspect'], arch)

        # 低通设计意图 (lp < 4000) 即使标为 foley_snap 也不应误受 B4 硬挂
        jg_lp = J.judge_wave(gauss_flat, D.SR, 'foley_snap', spec={'lp': 2400})
        self.assertFalse(jg_lp['forensics']['b4_kurt']['hit'])
        self.assertFalse(jg_lp['forensics']['b4_kurt']['suspect'])

        # 2) < 2.9 硬拒：v1 敲铁板+15ms白噪机制重建 + 正弦合成音 under foley_snap/wood
        w_metal, _ = P.modal_impact('metal_plate', dur=0.18, seed=1000)
        nz_n = D.N(0.015)
        w_v1recon = w_metal.copy()
        w_v1recon[:nz_n] += rng.normal(0.0, 0.05, nz_n) * np.hanning(nz_n)
        jg_v1r = J.judge_wave(w_v1recon, D.SR, 'foley_snap')
        self.assertLess(jg_v1r['forensics']['b4_kurt']['kurtosis'], 2.9)
        self.assertTrue(jg_v1r['forensics']['b4_kurt']['hit'])
        self.assertEqual(jg_v1r['status'], 'reject')
        self.assertTrue(jg_v1r['physics_hard_fail'])

        # 3) 2.9–3.2 suspect 边界：慢包络平稳带通高斯噪声（确定性落入 [2.9, 3.2)）
        r_s = np.random.default_rng(2)
        n_sus = D.N(0.45)
        t_sus = np.arange(n_sus) / float(D.SR)
        env_sus = np.minimum(1.0, t_sus / 0.008) * np.exp(-t_sus / 0.14)
        suspect_wave = sosfiltfilt(sos, r_s.standard_normal(n_sus)) * env_sus
        suspect_wave = suspect_wave / max(1e-9, float(np.max(np.abs(suspect_wave)))) * 0.55
        b4_sus = J.measure_deenv_kurtosis(suspect_wave, D.SR, archetype='friction_cloth')
        self.assertEqual(b4_sus['status'], 'suspect', b4_sus)
        self.assertFalse(b4_sus['hit'])
        self.assertTrue(b4_sus['suspect'])
        self.assertGreaterEqual(b4_sus['kurtosis'], 2.9)
        self.assertLess(b4_sus['kurtosis'], 3.2)
        jg_sus = J.judge_wave(suspect_wave, D.SR, 'friction_cloth')
        self.assertTrue(jg_sus['ok'], '2.9–3.2 边界只标 suspect 不应硬拒')
        self.assertFalse(jg_sus['physics_hard_fail'])
        self.assertFalse(jg_sus['flippable'])
        self.assertEqual(jg_sus['status'], 'suspect')
        self.assertTrue(any('存疑边界区' in r for r in jg_sus['reasons']), jg_sus['reasons'])

        # 4) > 45.0 极端稀疏尖刺硬拒
        n_sp = D.N(0.40)
        spike_sig = D.bp(rng.standard_normal(n_sp), 2500.0, 6500.0, 2) * 0.08
        for idx in range(D.N(0.04), n_sp - D.N(0.04), D.N(0.03)):
            m_sp = 16
            spike_sig[idx:idx + m_sp] += np.sin(2.0 * np.pi * 4000.0 * np.arange(m_sp) / float(D.SR)) * np.hanning(m_sp) * 1.6
        spike_sig = D.fade(spike_sig / max(1e-9, float(np.max(np.abs(spike_sig)))) * 0.85, 0.004, 0.004)
        b4_hi = J.measure_deenv_kurtosis(spike_sig, D.SR, archetype='impact')
        self.assertGreater(b4_hi['kurtosis'], 45.0)
        self.assertTrue(b4_hi['hit'])
        self.assertEqual(b4_hi['status'], 'reject')

        # 5) 合法留白（低电平环境底床）零硬拒
        quiet_amb = D.hp(D.lp(rng.standard_normal(D.N(0.5)), 3800.0, 2), 90.0, 2) * 0.002
        self.assertEqual(J.judge_wave(quiet_amb, D.SR, 'ambience')['status'], 'pass')

    def test_no_b2_no_torch_and_non_flippable_physics_gate_contract(self):
        # 严禁合入 B2 与 torch / open_clip
        self.assertFalse(hasattr(J, 'b2_cepstral_comb'))
        self.assertFalse(hasattr(J, 'B2_EXEMPT_ARCHETYPES'))
        proc = subprocess.run(
            [
                sys.executable, '-c',
                "import sys, engine.audio.sfx_judge; bad=[m for m in sys.modules if m.startswith(('torch','open_clip'))]; sys.exit(1 if bad else 0)",
            ],
            cwd=H.ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

        clean = _crisp_cut(0.18, seed=31)
        mid = len(clean) // 2

        # 构造 B1 / B3 / B4 / 削波 四类物理挂样本，用超高正边际/满分上层评分施压，绝不可翻转
        bad_click = clean.copy()
        bad_click[mid] += 0.65
        bad_zoh16 = np.repeat(clean[::3], 3)[:len(clean)]
        bad_v1r, _ = P.modal_impact('metal_plate', dur=0.18, seed=1001)
        bad_clip = np.clip(clean * 3.0, -1.0, 1.0)

        for label, wave, arch in (
            ('b1_click', bad_click, 'foley_snap'),
            ('b3_zoh16', bad_zoh16, 'foley_snap'),
            ('b4_v1recon', bad_v1r, 'foley_snap'),
            ('clip', bad_clip, 'impact'),
        ):
            res = J.judge_wave(wave, D.SR, arch)
            self.assertEqual(res['status'], 'reject', (label, res))
            self.assertNotIn('b2_comb', res['forensics'])
            for sc in (6.65, 20.0, 100.0):
                gate = J.combine_physics_gate(res, upper_status='pass', upper_score=sc)
                self.assertFalse(gate['ok'], (label, gate))
                self.assertEqual(gate['status'], 'reject', (label, gate))
                self.assertFalse(gate['flippable'])
                self.assertTrue(gate['physics_hard_fail'])

        # 物理 suspect 不可被上层 pass 翻回 pass
        sus_res = {'ok': True, 'status': 'suspect', 'physics_hard_fail': False, 'reasons': ['borderline']}
        g_sus = J.combine_physics_gate(sus_res, upper_status='pass', upper_score=15.0)
        self.assertTrue(g_sus['ok'])
        self.assertEqual(g_sus['status'], 'suspect')
        self.assertFalse(g_sus['flippable'])

        # 物理 pass + 上层只能行使降级标存疑权（默认不可直接拒收）
        pass_res = J.judge_wave(clean, D.SR, 'foley_snap')
        self.assertEqual(pass_res['status'], 'pass')
        self.assertTrue(pass_res['flippable'])
        g_down = J.combine_physics_gate(pass_res, upper_status='reject', upper_score=-5.0, upper_reason='low_margin')
        self.assertTrue(g_down['ok'])
        self.assertEqual(g_down['status'], 'suspect')
        self.assertFalse(g_down['flippable'])

        g_auth_rej = J.combine_physics_gate(pass_res, upper_status='reject', allow_upper_reject=True, upper_reason='calibrated_reject')
        self.assertFalse(g_auth_rej['ok'])
        self.assertEqual(g_auth_rej['status'], 'reject')

        with self.assertRaises(ValueError):
            J.combine_physics_gate(pass_res, upper_status='unknown')
        for bad_phys in ({}, None, {'status': 'bogus'}):
            with self.assertRaises(ValueError):
                J.combine_physics_gate(bad_phys, upper_status='pass')


if __name__ == '__main__':
    unittest.main()
