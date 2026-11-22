# -*- coding: utf-8 -*-
"""双刃剪刀行进式剪切物理因果合成器 procedural.shearing_cut 单元测试。"""
import inspect
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import editorial as E, foley as F, procedural as P, sfx_judge as J  # noqa: E402
from engine.audio.dsp import SR, N, rng, rms  # noqa: E402


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


def _band_energy_ratio(x: np.ndarray, f_lo: float, f_hi: float = None, sr: int = SR) -> float:
    w = np.asarray(x, dtype=float)
    if w.ndim == 2:
        w = w.mean(axis=1)
    spec = np.abs(np.fft.rfft(w)) ** 2
    freqs = np.fft.rfftfreq(len(w), 1.0 / float(sr))
    tot = float(np.sum(spec))
    if tot <= 1e-30:
        return 0.0
    mask = (freqs >= f_lo) if f_hi is None else ((freqs >= f_lo) & (freqs <= f_hi))
    return float(np.sum(spec[mask])) / tot


class ShearingCutTests(unittest.TestCase):
    def _assert_clean_stereo(self, x: np.ndarray, anc: float, expected_len: int, sr: int = SR, msg: str = ''):
        self.assertIsInstance(x, np.ndarray, msg)
        self.assertEqual(x.ndim, 2, msg)
        self.assertEqual(x.shape, (expected_len, 2), msg)
        self.assertEqual(x.dtype, np.float64, msg)
        self.assertTrue(np.all(np.isfinite(x)), f'含 NaN/Inf: {msg}')
        pk = float(np.max(np.abs(x)))
        self.assertLessEqual(pk, 0.92 + 1e-6, f'峰值超出安全上限 ({pk}): {msg}')
        self.assertGreater(rms(x), 1e-3, f'信号过弱: {msg}')
        self.assertLess(float(np.max(np.abs(np.mean(x, axis=0)))), 0.005, f'直流偏移偏大: {msg}')
        self.assertLess(float(np.max(np.abs(x[0]))), 1e-4, f'首样本咔嗒台阶: {msg}')
        self.assertLess(float(np.max(np.abs(x[-1]))), 1e-4, f'末样本咔嗒台阶: {msg}')
        corr = float(np.corrcoef(x[:, 0], x[:, 1])[0, 1])
        self.assertGreater(corr, 0.35, f'单声道兼容性不足 ({corr}): {msg}')
        self.assertLess(corr, 0.998, f'双刃近麦立体声完全退化为单声道 ({corr}): {msg}')
        dur_actual = (len(x) - 1) / float(sr)
        self.assertGreaterEqual(anc, 0.0, f'锚点为负 ({anc}): {msg}')
        self.assertLessEqual(anc, dur_actual + 1e-9, f'锚点越界 ({anc} > {dur_actual}): {msg}')

    def test_exports_and_signature_contract(self):
        self.assertEqual(
            P.SHEAR_MATERIALS,
            ('xuan_paper', 'cardstock', 'craft_paper', 'silk_fabric', 'thin_foil'),
        )
        self.assertEqual(P.SHEAR_STROKES, ('full', 'medium', 'tip_snip'))
        self.assertIn('SHEAR_MATERIALS', P.__all__)
        self.assertIn('SHEAR_STROKES', P.__all__)
        self.assertIn('shearing_cut', P.__all__)

        sig = inspect.signature(P.shearing_cut)
        params = list(sig.parameters.values())
        self.assertEqual(
            [p.name for p in params],
            [
                'dur', 'material', 'stroke', 'blade_len_cm', 'closing_speed',
                'pressure', 'tip_stop', 'exciter_sample', 'sr', 'seed',
            ],
        )
        self.assertEqual(params[0].default, 0.090)
        self.assertEqual(params[1].default, 'xuan_paper')
        self.assertEqual(params[2].default, 'full')
        self.assertEqual(params[3].default, 9.5)
        self.assertEqual(params[4].default, 1.0)
        self.assertEqual(params[5].default, 0.75)
        self.assertIs(params[6].default, True)
        self.assertIsNone(params[7].default)
        self.assertEqual(params[8].default, SR)
        self.assertEqual(params[9].default, 0)

        with self.assertRaises(ValueError):
            P.shearing_cut(material='kevlar_unknown')
        with self.assertRaises(ValueError):
            P.shearing_cut(stroke='half_unknown')
        with self.assertRaises(ValueError):
            P.shearing_cut(sr=4000)

        w_zero, a_zero = P.shearing_cut(0.08, closing_speed=0.0)
        self.assertEqual(w_zero.shape, (N(0.08), 2))
        self.assertEqual(float(np.max(np.abs(w_zero))), 0.0)
        self.assertEqual(a_zero, 0.0)

    def test_all_materials_and_strokes_forensic_judge_and_upward_chirp(self):
        stroke_durs = {'full': 0.095, 'medium': 0.062, 'tip_snip': 0.038}

        for mat in P.SHEAR_MATERIALS:
            for stroke in P.SHEAR_STROKES:
                for dur in (stroke_durs[stroke], 0.090):
                    tag = f'{mat}_{stroke}_{int(dur * 1000)}ms'
                    w, anc = P.shearing_cut(dur=dur, material=mat, stroke=stroke, seed=0)
                    self._assert_clean_stereo(w, anc, N(dur), SR, msg=tag)

                    v_snap = J.judge_wave(w, SR, archetype='foley_snap')
                    v_cloth = J.judge_wave(w, SR, archetype='friction_cloth')
                    v_onto = J.judge_ontology(w, SR, power='passive', name=f'scissors_{mat}_{stroke}')
                    self.assertTrue(v_snap['ok'], f'{tag} foley_snap 未通过: {v_snap}')
                    self.assertEqual(v_snap['status'], 'pass', f'{tag} foley_snap 非满分 pass: {v_snap}')
                    self.assertTrue(v_cloth['ok'], f'{tag} friction_cloth 未通过: {v_cloth}')
                    self.assertEqual(v_cloth['status'], 'pass', f'{tag} friction_cloth 非满分 pass: {v_cloth}')
                    self.assertTrue(v_onto['ok'], f'{tag} judge_ontology 未通过: {v_onto}')
                    self.assertEqual(v_onto['status'], 'pass', f'{tag} judge_ontology 非 pass: {v_onto}')

                    m = v_snap['metrics']
                    self.assertLess(m['hf_envelope_buzz'], 0.30, f'{tag} 高频周期嗡声过高: {m}')
                    self.assertLess(m['hf_whistle_db'], 15.0, f'{tag} 金属窄带哨音过高: {m}')
                    self.assertGreater(m['bandwidth_95_hz'], 10500.0, f'{tag} 95% 带宽不足: {m}')
                    self.assertGreater(
                        _band_energy_ratio(w, 12000.0, 20000.0), 0.01,
                        f'{tag} 缺少 12–20 kHz 全带宽纸刃脆度',
                    )

                    # 物理断言：悬臂有效刃长缩短驱动后段谱质心显著高于前段谱质心（行进式上滑 chirp）
                    c_early = _spectral_centroid(w[int(0.06 * len(w)):int(0.42 * len(w))])
                    c_late = _spectral_centroid(w[int(0.46 * len(w)):int(0.84 * len(w))])
                    self.assertGreater(
                        c_late, c_early * 1.11,
                        f'{tag} 未呈现显著上滑剪切 chirp: early={c_early:.1f} Hz, late={c_late:.1f} Hz',
                    )
                    mid = len(w) // 2
                    self.assertGreater(
                        _spectral_centroid(w[mid:]), _spectral_centroid(w[:mid]) * 1.10,
                        f'{tag} 后半程整体质心未高于前半程',
                    )

    def test_determinism_seed_variation_and_custom_sample_rates(self):
        w0a, a0a = P.shearing_cut(0.090, material='xuan_paper', stroke='full', seed=17)
        w0b, a0b = P.shearing_cut(0.090, material='xuan_paper', stroke='full', seed=17)
        w1, _ = P.shearing_cut(0.090, material='xuan_paper', stroke='full', seed=18)
        np.testing.assert_array_equal(w0a, w0b)
        self.assertEqual(a0a, a0b)
        self.assertFalse(np.allclose(w0a, w1))

        for sr_custom in (44100, 96000):
            dur = 0.075
            wc, ac = P.shearing_cut(dur, material='craft_paper', stroke='medium', sr=sr_custom, seed=5)
            expected_n = int(round(dur * sr_custom))
            self._assert_clean_stereo(wc, ac, expected_n, sr=sr_custom, msg=f'sr_{sr_custom}')

    def test_physical_kinematics_blade_length_speed_pressure_and_stroke_ordering(self):
        # 1) 剪刃越短（绣花小剪 5.5cm vs 常规剪 9.5cm vs 大裁缝剪 16.5cm），悬臂模态与整体谱质心越高
        c_blades = [
            _spectral_centroid(P.shearing_cut(0.095, material='xuan_paper', blade_len_cm=bl, seed=4)[0])
            for bl in (5.5, 9.5, 16.5)
        ]
        self.assertGreater(c_blades[0], c_blades[1] * 1.04, f'blade_len_cm 单调性异常: {c_blades}')
        self.assertGreater(c_blades[1], c_blades[2] * 1.04, f'blade_len_cm 单调性异常: {c_blades}')

        # 2) 闭合速度 closing_speed 与法向预紧力 pressure 增大 → 有效声功率单调上升
        rms_spd = [
            rms(P.shearing_cut(0.090, material='xuan_paper', closing_speed=s, seed=4)[0])
            for s in (0.45, 1.0, 1.85)
        ]
        self.assertLess(rms_spd[0], rms_spd[1])
        self.assertLess(rms_spd[1], rms_spd[2])

        rms_press = [
            rms(P.shearing_cut(0.090, material='xuan_paper', pressure=pr, seed=4)[0])
            for pr in (0.25, 0.75, 1.35)
        ]
        self.assertLess(rms_press[0], rms_press[1])
        self.assertLess(rms_press[1], rms_press[2])

        # 3) 行程起点 u0 越靠近刀尖（full 0.08 < medium 0.28 < tip_snip 0.58），起剪前段谱质心严格递增
        early_n = N(0.035)
        c_strokes = [
            _spectral_centroid(P.shearing_cut(0.090, material='xuan_paper', stroke=st, seed=6)[0][:early_n])
            for st in ('full', 'medium', 'tip_snip')
        ]
        self.assertLess(c_strokes[0], c_strokes[1], f'stroke 起剪质心顺序异常: {c_strokes}')
        self.assertLess(c_strokes[1], c_strokes[2], f'stroke 起剪质心顺序异常: {c_strokes}')

        # 4) 材质物理谱特征：细密丝绸/金属箔谱质心显著高于厚重硬卡纸/折叠宣纸
        c_card = _spectral_centroid(P.shearing_cut(0.090, material='cardstock', seed=3)[0])
        c_xuan = _spectral_centroid(P.shearing_cut(0.090, material='xuan_paper', seed=3)[0])
        c_silk = _spectral_centroid(P.shearing_cut(0.090, material='silk_fabric', seed=3)[0])
        c_foil = _spectral_centroid(P.shearing_cut(0.090, material='thin_foil', seed=3)[0])
        self.assertGreater(c_silk, c_xuan * 1.08)
        self.assertGreater(c_foil, c_card * 1.08)

    def test_end_of_stroke_tip_kiss_and_zero_t0_bell_clang(self):
        dur = 0.095
        w_tip, _ = P.shearing_cut(dur, material='xuan_paper', stroke='full', tip_stop=True, seed=9)
        w_notip, _ = P.shearing_cut(dur, material='xuan_paper', stroke='full', tip_stop=False, seed=9)

        # 1) 杜绝 t=0 敲钢板式起始硬冲击：开头 4 ms 能量远低于冲程中段剪切主体
        rms_t0 = rms(w_tip[:N(0.004)])
        rms_mid = rms(w_tip[N(0.024):N(0.068)])
        self.assertLess(rms_t0, rms_mid * 0.05, f'开头 4 ms 存在非物理硬冲击: t0={rms_t0}, mid={rms_mid}')

        # 2) tip_stop=True 在行程末端（0.80–0.90 dur）产生清晰双尖闭合与断口释能，且在 < 8 ms 内迅速阻尼衰减
        rms_kiss_on = rms(w_tip[N(0.078):N(0.088)])
        rms_kiss_off = rms(w_notip[N(0.078):N(0.088)])
        self.assertGreater(rms_kiss_on, rms_kiss_off * 5.0, 'tip_stop=True 未在行程末端产生显著闭合收音')

        # 闭合点（约 80.8 ms）后 8 ms 以外（>= 89 ms）残余能量衰减超过 20 dB（< 0.1 倍），绝无金属钟鸣拖尾
        rms_after_8ms = rms(w_tip[N(0.089):])
        self.assertLess(rms_after_8ms, rms_kiss_on * 0.10, f'末端闭合衰减超过 8 ms 仍有拖尾: {rms_after_8ms}')

    def test_hybrid_exciter_sample_1d_2d_and_rumble_rejection(self):
        r = rng(108)
        rec_base, _ = P.shearing_cut(0.082, material='craft_paper', stroke='full', seed=55)
        t_rec = np.arange(len(rec_base), dtype=float) / float(SR)
        # 注入 55 Hz 话筒低频隆隆声与安静前导，验证混合引擎的高通清底与智能包络贴合
        hum = 0.25 * np.sin(2.0 * np.pi * 55.0 * t_rec)
        rec_1d = np.concatenate([np.zeros(N(0.015)), rec_base[:, 0] + hum, np.zeros(N(0.015))])
        rec_2d = np.column_stack([rec_1d, rec_1d * 0.92])

        w_pure, _ = P.shearing_cut(0.095, material='xuan_paper', stroke='full', exciter_sample=None, seed=12)

        for label, target_dur, st_kind, exc in (
            ('mono_matched', 0.095, 'full', rec_1d),
            ('stereo_extended', 0.125, 'full', rec_2d),
            ('stereo_trimmed_snip', 0.040, 'tip_snip', rec_2d),
        ):
            wh, ah = P.shearing_cut(
                target_dur, material='xuan_paper', stroke=st_kind, exciter_sample=exc, seed=12,
            )
            self._assert_clean_stereo(wh, ah, N(target_dur), SR, msg=label)
            if abs(target_dur - 0.095) < 1e-6:
                self.assertFalse(np.allclose(wh, w_pure), 'exciter_sample 未生效')

            vf = J.judge_wave(wh, SR, archetype='foley_snap')
            vc = J.judge_wave(wh, SR, archetype='friction_cloth')
            vo = J.judge_ontology(wh, SR, power='passive', name=f'hybrid_{label}')
            self.assertTrue(vf['ok'], f'{label} foley_snap 未通过: {vf}')
            self.assertTrue(vc['ok'], f'{label} friction_cloth 未通过: {vc}')
            self.assertTrue(vo['ok'], f'{label} ontology 未通过: {vo}')
            self.assertLess(vo['metrics']['loop_periodicity'], 0.65, f'{label} 存在周期循环痕迹')
            self.assertLess(_band_energy_ratio(wh, 0.0, 100.0), 0.005, f'{label} 未滤除实录 <100 Hz 隆隆声')

            c_e = _spectral_centroid(wh[int(0.08 * len(wh)):int(0.42 * len(wh))])
            c_l = _spectral_centroid(wh[int(0.46 * len(wh)):int(0.84 * len(wh))])
            self.assertGreater(c_l, c_e, f'{label} 混合拟音丢失上滑剪切特征')

    def test_editorial_and_foley_pipeline_integration(self):
        takes = [
            P.shearing_cut(0.088, material='xuan_paper', stroke='full', seed=k)[0]
            for k in range(4)
        ]
        snip_w, snip_anc = P.shearing_cut(0.040, material='xuan_paper', stroke='tip_snip', seed=9)

        buf = np.zeros((N(2.0), 2), dtype=np.float64)
        info = F.place_anchored(buf, snip_w, t_hit=0.35, anchor=snip_anc, gain=0.8, pan=0.05)
        self.assertIn('placed_at', info)

        edited, ed_anc = E.smart_edit_clip(takes[0], visual_dur=0.080, mode='sustained', anchor=0.018, seed=3)
        self.assertTrue(np.all(np.isfinite(edited)))
        self.assertGreaterEqual(ed_anc, 0.0)

        series = E.schedule_action_series(
            [0.50, 0.75, 1.00, 1.25],
            forces=[0.65, 0.75, 0.85, 1.05],
            takes=takes,
            policy='anti_fatigue',
            seed=5,
        )
        self.assertEqual(len(series), 4)
        for ev in series:
            F.place_anchored(buf, ev['wave'], t_hit=ev['t_hit'], anchor=ev['anchor'], gain=0.7)
        self.assertTrue(np.all(np.isfinite(buf)))
        self.assertGreater(rms(buf), 1e-3)


if __name__ == '__main__':
    unittest.main()
