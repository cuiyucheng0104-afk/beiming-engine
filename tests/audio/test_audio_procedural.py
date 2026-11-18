# -*- coding: utf-8 -*-
"""物理因果与风格化音效合成层 engine/audio/procedural.py 单元测试。"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import director as D, procedural as P, sfx_judge as J  # noqa: E402
from engine.audio.dsp import SR, N, T, rng, rms  # noqa: E402


def _spectral_centroid(x: np.ndarray, sr: int = SR) -> float:
    w = np.asarray(x, dtype=float)
    if w.ndim == 2:
        w = w.mean(axis=1)
    if len(w) < 8:
        return 0.0
    mag = np.abs(np.fft.rfft(w * np.hanning(len(w))))
    freqs = np.fft.rfftfreq(len(w), 1.0 / float(sr))
    denom = float(np.sum(mag))
    return float(np.dot(freqs, mag) / denom) if denom > 1e-15 else 0.0


def _dominant_freq(x: np.ndarray, sr: int = SR, f_lo: float = 40.0, f_hi: float = 16000.0) -> float:
    w = np.asarray(x, dtype=float)
    if w.ndim == 2:
        w = w.mean(axis=1)
    n_fft = max(len(w), 16384)
    mag = np.abs(np.fft.rfft(w * np.hanning(len(w)), n=n_fft))
    freqs = np.fft.rfftfreq(n_fft, 1.0 / float(sr))
    mask = (freqs >= f_lo) & (freqs <= f_hi)
    sub_mag = mag[mask]
    sub_fq = freqs[mask]
    return float(sub_fq[int(np.argmax(sub_mag))]) if len(sub_mag) else 0.0


class ProceduralAudioTests(unittest.TestCase):
    def _assert_clean_wave(self, x: np.ndarray, anc: float, expected_dur: float = None, msg: str = ''):
        self.assertIsInstance(x, np.ndarray, msg)
        self.assertEqual(x.ndim, 1, msg)
        self.assertEqual(x.dtype, np.float64, msg)
        if expected_dur is not None:
            self.assertEqual(len(x), N(expected_dur), msg)
        self.assertTrue(np.all(np.isfinite(x)), f'存在 NaN/Inf: {msg}')
        pk = float(np.max(np.abs(x)))
        self.assertLess(pk, 0.99, f'峰值接近或发生削波 ({pk}): {msg}')
        self.assertGreater(rms(x), 1e-4, f'信号过弱或全静音: {msg}')
        self.assertLess(abs(float(np.mean(x))), 0.015, f'直流偏移偏大: {msg}')
        dur_actual = (len(x) - 1) / float(SR)
        self.assertGreaterEqual(anc, 0.0, f'锚点为负 ({anc}): {msg}')
        self.assertLessEqual(anc, dur_actual + 1e-9, f'锚点越界 ({anc} > {dur_actual}): {msg}')

    # ———— 1. modal_impact 测试 ————
    def test_modal_impact_all_materials_and_determinism(self):
        required = {
            'wood_hollow', 'bamboo', 'bronze_bell', 'ceramic',
            'glass_crystal', 'metal_plate', 'stone_slate',
        }
        self.assertTrue(required.issubset(set(P.MATERIAL_MODES.keys())))

        for mat in P.MATERIAL_MODES:
            w1, a1 = P.modal_impact(mat, dur=0.40, hardness=0.65, seed=17)
            w2, a2 = P.modal_impact(mat, dur=0.40, hardness=0.65, seed=17)
            w3, _ = P.modal_impact(mat, dur=0.40, hardness=0.65, seed=18)
            self._assert_clean_wave(w1, a1, expected_dur=0.40, msg=mat)
            self.assertLess(a1, 0.04, f'{mat} 锤击冲击锚点应位于开头瞬态区')
            np.testing.assert_array_equal(w1, w2)
            self.assertEqual(a1, a2)
            self.assertFalse(np.allclose(w1, w3))

        with self.assertRaises(ValueError):
            P.modal_impact('unobtainium')

    def test_modal_impact_size_hardness_damping_and_key_snapping(self):
        # 1) size_scale 增大 → 模态频率与频谱质心严格单调递减
        scales = (0.55, 1.0, 1.85, 3.2)
        dom_freqs = []
        centroids = []
        for sc in scales:
            w, _ = P.modal_impact('ceramic', dur=0.38, hardness=0.7, size_scale=sc, seed=5)
            dom_freqs.append(_dominant_freq(w))
            centroids.append(_spectral_centroid(w))
        for a, b in zip(dom_freqs, dom_freqs[1:]):
            self.assertGreater(a, b * 1.35, f'size_scale 增大时主频未单调下降: {dom_freqs}')
        for a, b in zip(centroids, centroids[1:]):
            self.assertGreater(a, b * 1.25, f'size_scale 增大时谱质心未单调下降: {centroids}')

        # 2) hardness 增大 → 赫兹接触时长缩短，高频激发单调增强
        hard_centroids = [
            _spectral_centroid(P.modal_impact('metal_plate', dur=0.35, hardness=h, seed=9)[0])
            for h in (0.08, 0.45, 0.92)
        ]
        self.assertLess(hard_centroids[0], hard_centroids[1])
        self.assertLess(hard_centroids[1], hard_centroids[2])

        # 3) damp_scale 增大 → 尾音衰减更快（后半段相对前半段能量比严格单调下降）
        tail_ratios = []
        for ds in (0.45, 1.0, 2.6):
            w, _ = P.modal_impact('bronze_bell', dur=0.60, damp_scale=ds, seed=11)
            head_e = rms(w[:N(0.08)])
            tail_e = rms(w[N(0.25):N(0.55)])
            tail_ratios.append(tail_e / max(head_e, 1e-12))
        self.assertGreater(tail_ratios[0], tail_ratios[1] * 1.22)
        self.assertGreater(tail_ratios[1], tail_ratios[2] * 1.45)

        # 4) key 调性吸附 → 主模态谱峰精确落在 director.harmonic_freq 协和音级上
        for mat, key_root in (('bronze_bell', 'D'), ('glass_crystal', 'A'), ('ceramic', 'F')):
            expected_hz = D.harmonic_freq(P.MATERIAL_MODES[mat]['f0'], root=key_root)
            w_k, _ = P.modal_impact(mat, dur=0.55, hardness=0.5, key=key_root, seed=3)
            # 跳过开头几毫秒宽带敲击瞬态，测纯模态余振主频
            meas_hz = _dominant_freq(w_k[N(0.02):], f_lo=expected_hz * 0.75, f_hi=expected_hz * 1.25)
            self.assertAlmostEqual(meas_hz, expected_hz, delta=3.5)

    def test_modal_impact_hybrid_foley_exciter_sample(self):
        r = rng(33)
        t = T(0.06)
        # 构造一段带 10ms 前导微刮擦 + 12ms 处硬瞬态的立体声伪实录切片
        scrape = 0.25 * np.sin(2 * np.pi * 1900 * t) * (t < 0.012)
        hit = (t >= 0.012) * np.exp(-np.maximum(0.0, t - 0.012) / 0.0025) * r.standard_normal(len(t))
        exc_st = np.column_stack([scrape + hit, scrape + hit * 0.9])

        w_hyb, anc_hyb = P.modal_impact('bamboo', dur=0.35, hardness=0.75, exciter_sample=exc_st, seed=4)
        w_pure, _ = P.modal_impact('bamboo', dur=0.35, hardness=0.75, exciter_sample=None, seed=4)
        self._assert_clean_wave(w_hyb, anc_hyb, expected_dur=0.35, msg='hybrid_bamboo')
        self.assertFalse(np.allclose(w_hyb, w_pure))
        # 混合激励仍应清晰激发 bamboo 主模态（~690 Hz）
        dom = _dominant_freq(w_hyb[N(0.025):], f_lo=450.0, f_hi=1000.0)
        self.assertAlmostEqual(dom, P.MATERIAL_MODES['bamboo']['f0'], delta=25.0)

    # ———— 2. phisem_particles 测试 ————
    def test_phisem_particles_materials_determinism_and_density_curve(self):
        required = {'gravel', 'coins', 'glass_shards', 'dry_leaves', 'embers', 'beads'}
        self.assertTrue(required.issubset(set(P.PHISEM_MATERIALS.keys())))

        centroids = {}
        for mat in P.PHISEM_MATERIALS:
            w1, a1 = P.phisem_particles(0.65, count=28, density=1.0, material=mat, seed=21)
            w2, a2 = P.phisem_particles(0.65, count=28, density=1.0, material=mat, seed=21)
            self._assert_clean_wave(w1, a1, expected_dur=0.65, msg=mat)
            np.testing.assert_array_equal(w1, w2)
            self.assertEqual(a1, a2)
            centroids[mat] = _spectral_centroid(w1)

        # 铜钱/碎玻璃的高频金属晶莹度显著高于木算盘珠
        self.assertGreater(centroids['coins'], centroids['beads'] * 1.35)
        self.assertGreater(centroids['glass_shards'], centroids['beads'] * 1.45)

        # 逐样本曲线驱动：前半段静默、后半段剧烈散落，能量与锚点随之迁移到后半段
        dur = 0.80
        n = N(dur)
        u = np.linspace(0.0, 1.0, n)
        curve_late = np.maximum(0.0, (u - 0.50) / 0.50) ** 0.8
        w_curve, anc_curve = P.phisem_particles(dur, count=36, density=curve_late, material='gravel', seed=12)
        self._assert_clean_wave(w_curve, anc_curve, expected_dur=dur, msg='curve_gravel')
        self.assertLess(rms(w_curve[:N(0.38)]), 1e-4)
        self.assertGreater(rms(w_curve[N(0.52):]), 0.02)
        self.assertGreater(anc_curve, 0.48)

        # 零密度安静无杂音
        w_zero, a_zero = P.phisem_particles(0.30, density=0.0, material='coins', seed=1)
        self.assertEqual(float(np.max(np.abs(w_zero))), 0.0)
        self.assertEqual(a_zero, 0.0)

        with self.assertRaises(ValueError):
            P.phisem_particles(0.3, material='unknown_dust')

    # ———— 3. aerodynamic_whoosh 测试 ————
    def test_aerodynamic_whoosh_strouhal_monotonicity_and_profiles(self):
        required = {'whip', 'heavy_club', 'wing_gust', 'scifi_pass'}
        self.assertTrue(required.issubset(set(P.WHOOSH_PROFILES.keys())))

        for prof in P.WHOOSH_PROFILES:
            w1, p1 = P.aerodynamic_whoosh(0.36, profile=prof, seed=15)
            w2, p2 = P.aerodynamic_whoosh(0.36, profile=prof, seed=15)
            self._assert_clean_wave(w1, p1, expected_dur=0.36, msg=prof)
            np.testing.assert_array_equal(w1, w2)
            self.assertEqual(p1, p2)

        # 自然气动破空（whip）应通过 sfx_judge 的 'whoosh' 物理取证（无口技/合成器周期谐波污染）
        w_whip, _ = P.aerodynamic_whoosh(0.34, profile='whip', diameter_m=0.018, seed=7)
        verdict = J.judge_wave(w_whip, SR, archetype='whoosh')
        self.assertTrue(verdict['ok'], f"whip 未通过 sfx_judge whoosh 取证: {verdict}")

        # 1) Strouhal 定律：直径 diameter_m 增大 → 涡街频率单调下降
        diam_centroids = [
            _spectral_centroid(P.aerodynamic_whoosh(0.35, profile='whip', diameter_m=d, seed=8)[0])
            for d in (0.008, 0.024, 0.075)
        ]
        self.assertGreater(diam_centroids[0], diam_centroids[1] * 1.25)
        self.assertGreater(diam_centroids[1], diam_centroids[2] * 1.25)

        # 2) Strouhal 定律 + v^3 功率律：speed_curve 速度越高（无论 0..1 归一化还是 m/s 物理速度），频率与有效响度严格单调上升
        norm_centroids, norm_rms = [], []
        for s_val in (0.25, 0.60, 1.15):
            w_s, _ = P.aerodynamic_whoosh(0.32, profile='whip', speed_curve=s_val, diameter_m=0.022, seed=19)
            norm_centroids.append(_spectral_centroid(w_s))
            norm_rms.append(rms(w_s))
        self.assertLess(norm_centroids[0], norm_centroids[1])
        self.assertLess(norm_centroids[1], norm_centroids[2])
        self.assertLess(norm_rms[0], norm_rms[1])
        self.assertLess(norm_rms[1], norm_rms[2])

        mps_centroids = [
            _spectral_centroid(P.aerodynamic_whoosh(0.32, profile='whip', speed_curve=v, diameter_m=0.020, seed=19)[0])
            for v in (8.0, 24.0, 52.0)
        ]
        self.assertLess(mps_centroids[0], mps_centroids[1])
        self.assertLess(mps_centroids[1], mps_centroids[2])

        # 3) 外部时变 speed_curve 实时跟随：峰值设在 0.25 * dur 处时，P-Center 锚点精准跟随至 0.25 * dur
        dur = 0.40
        u = np.linspace(0.0, 1.0, N(dur))
        custom_spd = np.exp(-((u - 0.25) / 0.10) ** 2)
        w_c, anc_c = P.aerodynamic_whoosh(dur, profile='heavy_club', speed_curve=custom_spd, weight=1.2, seed=6)
        self._assert_clean_wave(w_c, anc_c, expected_dur=dur, msg='custom_speed_whoosh')
        self.assertAlmostEqual(anc_c, 0.25 * dur, delta=0.015)

        with self.assertRaises(ValueError):
            P.aerodynamic_whoosh(0.3, profile='invalid_profile')

    # ———— 4. minnaert_bubbles 测试 ————
    def test_minnaert_bubbles_radius_frequency_law_and_chirp(self):
        w1, a1 = P.minnaert_bubbles(0.85, rate=14.0, radius_mm=(1.5, 6.0), chirp=0.14, seed=29)
        w2, a2 = P.minnaert_bubbles(0.85, rate=14.0, radius_mm=(1.5, 6.0), chirp=0.14, seed=29)
        self._assert_clean_wave(w1, a1, expected_dur=0.85, msg='minnaert_default')
        np.testing.assert_array_equal(w1, w2)
        self.assertEqual(a1, a2)

        # Minnaert 定律 f_0 ≈ 3.26 / r_0 = 3260 / r_mm：半径增大时共振频率严格单调下降且贴合理论值
        radii_mm = (1.2, 2.2, 4.0, 7.5)
        meas_freqs = []
        for r_mm in radii_mm:
            wb, _ = P.minnaert_bubbles(0.55, rate=5.0, radius_mm=r_mm, chirp=0.0, depth_lp_hz=18000.0, seed=4)
            f_dom = _dominant_freq(wb, f_lo=200.0, f_hi=6000.0)
            meas_freqs.append(f_dom)
            f_theo = 3260.0 / r_mm
            self.assertAlmostEqual(f_dom, f_theo, delta=f_theo * 0.06)

        for fa, fb in zip(meas_freqs, meas_freqs[1:]):
            self.assertGreater(fa, fb * 1.45, f'气泡半径增大时频率未单调递减: {meas_freqs}')

        # 表面张力上滑 chirp：单颗大泡在 chirp > 0 时尾段频率显著高于起音段
        w_chirp, _ = P.minnaert_bubbles(0.45, rate=1.2, radius_mm=5.0, chirp=0.32, depth_lp_hz=16000.0, seed=2)
        pk_i = int(np.argmax(np.abs(w_chirp)))
        i_start = max(0, pk_i - N(0.002))
        seg_early = w_chirp[i_start:min(len(w_chirp), i_start + N(0.018))]
        seg_late = w_chirp[min(len(w_chirp) - N(0.02), i_start + N(0.018)):min(len(w_chirp), i_start + N(0.045))]
        if len(seg_early) >= 128 and len(seg_late) >= 128:
            self.assertGreater(_spectral_centroid(seg_late), _spectral_centroid(seg_early) * 1.08)

        # 水深低通吸收：浅水清亮 > 深水闷暗
        w_shallow, _ = P.minnaert_bubbles(0.6, rate=16.0, radius_mm=(0.9, 2.5), depth_lp_hz=12000.0, seed=10)
        w_deep, _ = P.minnaert_bubbles(0.6, rate=16.0, radius_mm=(0.9, 2.5), depth_lp_hz=850.0, seed=10)
        self.assertGreater(_spectral_centroid(w_shallow), _spectral_centroid(w_deep) * 1.6)

    # ———— 5. stylized_cartoon 测试 ————
    def test_stylized_cartoon_all_kinds_pitch_and_direction(self):
        required = {'boing', 'pop', 'zip', 'blink', 'slide_up', 'slide_down', 'bonk'}
        self.assertEqual(set(P.CARTOON_KINDS), required)

        for kind in P.CARTOON_KINDS:
            w1, a1 = P.stylized_cartoon(kind, dur=0.28, intensity=1.0, pitch_hz=320.0, seed=13)
            w2, a2 = P.stylized_cartoon(kind, dur=0.28, intensity=1.0, pitch_hz=320.0, seed=13)
            self._assert_clean_wave(w1, a1, expected_dur=0.28, msg=kind)
            np.testing.assert_array_equal(w1, w2)
            self.assertEqual(a1, a2)

            # 基准 pitch_hz 升高 → 各原语谱质心严格单调上升
            c_lo = _spectral_centroid(P.stylized_cartoon(kind, dur=0.26, pitch_hz=180.0, seed=5)[0])
            c_mid = _spectral_centroid(P.stylized_cartoon(kind, dur=0.26, pitch_hz=360.0, seed=5)[0])
            c_hi = _spectral_centroid(P.stylized_cartoon(kind, dur=0.26, pitch_hz=720.0, seed=5)[0])
            self.assertLess(c_lo, c_mid, f'{kind} pitch_hz 单调性异常 (lo vs mid)')
            self.assertLess(c_mid, c_hi, f'{kind} pitch_hz 单调性异常 (mid vs hi)')

        # 上滑音 / 极速蹿出：后半段频率高于前半段；下滑音：前半段频率高于后半段
        for up_kind in ('slide_up', 'zip'):
            wu, _ = P.stylized_cartoon(up_kind, dur=0.32, pitch_hz=280.0, seed=3)
            mid = len(wu) // 2
            self.assertGreater(_spectral_centroid(wu[mid:]), _spectral_centroid(wu[:mid]) * 1.35)

        wd, _ = P.stylized_cartoon('slide_down', dur=0.32, pitch_hz=360.0, seed=3)
        mid_d = len(wd) // 2
        self.assertGreater(_spectral_centroid(wd[:mid_d]), _spectral_centroid(wd[mid_d:]) * 1.35)

        with self.assertRaises(ValueError):
            P.stylized_cartoon('honk_unknown')


if __name__ == '__main__':
    unittest.main()
