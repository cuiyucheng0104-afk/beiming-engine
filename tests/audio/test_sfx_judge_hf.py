# -*- coding: utf-8 -*-
"""高频程序化合成伪影取证指标（hf_envelope_buzz & hf_whistle_db）零回归校准与单元测试。"""
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
for _p in (ROOT, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from engine.audio import ambience as A, dsp as D, foley as F, procedural as P, sfx_judge as J  # noqa: E402


def _norm_peak(x: np.ndarray, target: float = 0.65) -> np.ndarray:
    arr = np.asarray(x, dtype=float)
    pk = float(np.max(np.abs(arr)))
    return arr * (target / pk) if pk > 1e-9 else arr


class SfxJudgeHighFreqArtifactTests(unittest.TestCase):
    def test_clean_broadband_archetypes_pass_with_wide_margin(self):
        """洁净宽带拟音（friction_cloth / whoosh / water / ambience）通过判定，且高频电嗡声与哨音指标远低于门限。"""
        dur_cloth = 0.65
        motion = np.sin(np.linspace(0.0, np.pi, D.N(dur_cloth))) ** 1.2
        cloth = _norm_peak(D.hp(F.cloth_rustle(dur_cloth, motion, seed=11), 40.0, 2))
        # F.cloth_rustle 纯无实录程序化纤维噪声（sin^1.2 慢包络）去包络峭度 ≈ 2.915，L3 B4 合理落入 [2.9, 3.2) suspect 边界区（ok=True，不误触发高频伪影）
        r_cloth = J.judge_wave(cloth, D.SR, 'friction_cloth')
        self.assertTrue(r_cloth['ok'], r_cloth)
        self.assertIn(r_cloth['status'], ('pass', 'suspect'), r_cloth)
        self.assertEqual([r for r in r_cloth['reasons'] if 'hf_' in r], [], r_cloth)
        self.assertLess(r_cloth['metrics']['hf_envelope_buzz'], 0.28, r_cloth)
        self.assertLess(r_cloth['metrics']['hf_whistle_db'], 11.0, r_cloth)

        whoosh, _ = P.aerodynamic_whoosh(0.42, profile='whip', diameter_m=0.018, seed=7)
        r_whoosh = J.judge_wave(_norm_peak(whoosh), D.SR, 'whoosh')
        self.assertTrue(r_whoosh['ok'], r_whoosh)
        self.assertEqual(r_whoosh['status'], 'pass', r_whoosh)
        self.assertLess(r_whoosh['metrics']['hf_envelope_buzz'], 0.28, r_whoosh)
        self.assertLess(r_whoosh['metrics']['hf_whistle_db'], 11.0, r_whoosh)

        water_cleave, _ = F.water_cleave(1.5, force=1.0, seed=5)
        r_water = J.judge_wave(_norm_peak(water_cleave), D.SR, 'water')
        self.assertTrue(r_water['ok'], r_water)
        self.assertEqual(r_water['status'], 'pass', r_water)
        self.assertLess(r_water['metrics']['hf_envelope_buzz'], 0.28, r_water)
        self.assertLess(r_water['metrics']['hf_whistle_db'], 11.0, r_water)

        bubbles, _ = P.minnaert_bubbles(0.90, rate=18.0, radius_mm=(0.8, 4.5), chirp=0.14, seed=9)
        r_bubbles = J.judge_wave(_norm_peak(bubbles), D.SR, 'water')
        self.assertTrue(r_bubbles['ok'], r_bubbles)
        self.assertEqual(r_bubbles['status'], 'pass', r_bubbles)
        self.assertLess(r_bubbles['metrics']['hf_envelope_buzz'], 0.28, r_bubbles)
        self.assertLess(r_bubbles['metrics']['hf_whistle_db'], 11.0, r_bubbles)

        amb_breeze = _norm_peak(A.breeze(1.6, seed=3))
        r_amb = J.judge_wave(amb_breeze, D.SR, 'ambience')
        self.assertTrue(r_amb['ok'], r_amb)
        self.assertEqual(r_amb['status'], 'pass', r_amb)
        self.assertLess(r_amb['metrics']['hf_envelope_buzz'], 0.28, r_amb)
        self.assertLess(r_amb['metrics']['hf_whistle_db'], 11.0, r_amb)

    def test_existing_synthesizers_zero_hf_false_positives(self):
        """遍历现有环境声、拟音与程序化物理合成器：任何洁净合成音均不触发 hf_envelope_buzz 或 hf_whistle_db 误报。"""
        gust = A.wind(1.4, 2, 'close')[1]
        footsteps = np.zeros(D.N(0.95))
        for at, seed_k in ((0.06, 1), (0.38, 2), (0.70, 3)):
            step_w, _ = P.phisem_particles(0.14, count=22, density=1.0, material='gravel', seed=seed_k)
            i0 = D.N(at)
            footsteps[i0:i0 + len(step_w)] += step_w * 0.7

        catalog = [
            ('ambience.wind_far', A.wind(1.4, 1, 'far')[0], 'ambience', True),
            ('ambience.wind_close', A.wind(1.4, 2, 'close')[0], 'ambience', True),
            ('ambience.wind_open', A.wind(1.4, 3, 'open')[0], 'ambience', True),
            ('ambience.water_far', A.water(1.5, 4, 'far'), 'ambience', True),
            ('ambience.water_hull', A.water(1.5, 5, 'hull'), 'water', True),
            ('ambience.city_hum', A.city_hum(1.5, 6), 'ambience', True),
            ('ambience.hair', A.hair(1.4, 7, gust), 'friction_cloth', True),
            ('foley.blade_whoosh', F.blade_whoosh(0.35, seed=8)[0], 'whoosh', True),
            ('foley.footsteps_gravel', footsteps, 'foley_snap', True),
            ('procedural.phisem_gravel', P.phisem_particles(0.60, count=28, material='gravel', seed=9)[0], 'foley_snap', True),
            ('procedural.phisem_beads', P.phisem_particles(0.55, count=24, material='beads', seed=10)[0], 'wood', True),
            ('procedural.whoosh_club', P.aerodynamic_whoosh(0.45, profile='heavy_club', seed=11)[0], 'whoosh', True),
            ('procedural.whoosh_wing', P.aerodynamic_whoosh(0.45, profile='wing_gust', seed=12)[0], 'foley_snap', True),
            ('procedural.minnaert_bubbles', P.minnaert_bubbles(0.85, rate=18.0, radius_mm=(0.7, 4.0), seed=13)[0], 'water', True),
            ('procedural.modal_wood_scaled', P.modal_impact('wood_hollow', dur=0.36, hardness=0.88, size_scale=0.55, seed=14)[0], 'wood', False),
            ('procedural.modal_bamboo_scaled', P.modal_impact('bamboo', dur=0.36, hardness=0.85, size_scale=0.65, seed=15)[0], 'wood', False),
        ]
        for label, wave, arch, require_ok in catalog:
            res = J.judge_wave(_norm_peak(wave), D.SR, arch)
            hf_reasons = [r for r in res['reasons'] if ('hf_envelope_buzz' in r or 'hf_whistle_db' in r)]
            self.assertEqual(hf_reasons, [], f'{label} 误触发高频伪影告警: {res}')
            if require_ok:
                self.assertTrue(res['ok'], f'{label} 判定未通过: {res}')

        # 覆盖全部 modal_impact 材质，确保 >6 kHz 包络自相关均远低于宽带上限
        for mat in P.MATERIAL_MODES:
            w_m, _ = P.modal_impact(mat, dur=0.42, hardness=0.72, seed=17)
            m = J.extract_metrics(_norm_peak(w_m), D.SR)
            self.assertLess(m['hf_envelope_buzz'], 0.28, f'modal_impact({mat}) 高频包络自相关异常偏高: {m}')

    def test_defective_120hz_pulse_modulated_hf_buzz_rejected(self):
        """120 Hz 等间距颗粒/脉冲调制 >6 kHz 布料与破空：即使 <5 kHz 基频谐波显著度近零，仍被 hf_envelope_buzz 精准拦截。"""
        rng = np.random.default_rng(2026)
        dur = 0.50
        n = D.N(dur)
        t = np.arange(n) / D.SR
        swell = np.sin(np.pi * np.clip(t / dur, 0.0, 1.0)) ** 1.3

        # 低中频主体为纯净湍流（<5 kHz 无周期谐波梳），高频 >6.8 kHz 混入未加抖动的 120 Hz 颗粒帧跳调制（每粒独立随机相位，频谱平坦）
        body = D.bp(rng.standard_normal(n), 260.0, 4600.0, 2) * 0.28
        grains = np.zeros(n)
        hop = int(round(D.SR / 120.0))
        g_len = int(round(hop * 0.50))
        win_g = np.hanning(g_len)
        for i in range(0, n - g_len, hop):
            grains[i:i + g_len] += D.hp(rng.standard_normal(g_len), 6800.0, 3) * win_g * 0.52
        defective = _norm_peak((body + grains) * swell)

        # 验证仅 <5 kHz 段完全无周期音高（旧 pitch_prominence 无法检出非相干载波颗粒电嗡声）
        only_lo = _norm_peak(body * swell)
        self.assertLess(J.extract_metrics(only_lo, D.SR)['pitch_prominence'], 0.25)

        for arch in ('friction_cloth', 'whoosh'):
            res = J.judge_wave(defective, D.SR, arch)
            self.assertFalse(res['ok'], res)
            self.assertEqual(res['status'], 'reject', res)
            self.assertLess(res['metrics']['pitch_prominence'], 0.28, res)
            self.assertGreater(res['metrics']['hf_envelope_buzz'], 0.60, res)
            self.assertLess(res['metrics']['hf_whistle_db'], 11.0, res)
            self.assertTrue(
                any('hf_envelope_buzz' in r for r in res['reasons']),
                f'{arch} 拒收原因未提及 hf_envelope_buzz: {res}',
            )

    def test_defective_9500hz_narrowband_whistle_rejected(self):
        """混入 9.5 kHz 窄带反馈哨音尖刺的破空与环境风声（hf_whistle_db > 20 dB）：必须被检出并拒收。"""
        whoosh_clean, _ = P.aerodynamic_whoosh(0.48, profile='whip', diameter_m=0.018, seed=21)
        t_w = np.arange(len(whoosh_clean)) / D.SR
        whistle_w = 0.045 * np.sin(2.0 * np.pi * 9500.0 * t_w) * np.hanning(len(whoosh_clean))
        whoosh_bad = _norm_peak(whoosh_clean + whistle_w)

        r_whoosh = J.judge_wave(whoosh_bad, D.SR, 'whoosh')
        self.assertFalse(r_whoosh['ok'], r_whoosh)
        self.assertEqual(r_whoosh['status'], 'reject', r_whoosh)
        self.assertGreater(r_whoosh['metrics']['hf_whistle_db'], 20.0, r_whoosh)
        self.assertLess(r_whoosh['metrics']['hf_envelope_buzz'], 0.28, r_whoosh)
        self.assertTrue(
            any('hf_whistle_db' in r for r in r_whoosh['reasons']),
            f'whoosh 拒收原因未提及 hf_whistle_db: {r_whoosh}',
        )

        amb_clean = _norm_peak(A.breeze(1.4, seed=22), target=0.50)
        t_a = np.arange(len(amb_clean)) / D.SR
        whistle_a = (0.055 * np.sin(2.0 * np.pi * 9500.0 * t_a) * np.hanning(len(amb_clean)))[:, None]
        amb_bad = _norm_peak(amb_clean + whistle_a)

        r_amb = J.judge_wave(amb_bad, D.SR, 'ambience')
        self.assertFalse(r_amb['ok'], r_amb)
        self.assertEqual(r_amb['status'], 'reject', r_amb)
        self.assertGreater(r_amb['metrics']['hf_whistle_db'], 20.0, r_amb)
        self.assertTrue(
            any('hf_whistle_db' in r for r in r_amb['reasons']),
            f'ambience 拒收原因未提及 hf_whistle_db: {r_amb}',
        )

    def test_tonal_metallic_bell_and_ui_legitimate_hf_partials_not_penalized(self):
        """金属刀剑（metal_blade）、青铜钟磬（bronze_bell）、界面乐音（tonal_ui）与精密机械（mechanical）合法高频泛音不误判。"""
        # 1) 金属剑鸣（metal_blade）
        blade, _ = F.blade_ring(1.05, f0=1520.0, brightness=1.1, seed=31)
        r_blade = J.judge_wave(_norm_peak(blade), D.SR, 'metal_blade')
        self.assertTrue(r_blade['ok'], r_blade)
        self.assertEqual(r_blade['status'], 'pass', r_blade)
        self.assertGreater(r_blade['metrics']['hf_whistle_db'], 25.0, r_blade)

        # 2) 青铜编钟（清亮小钟归 metal_blade；低沉编钟归 sustained_tonal）
        bell_bright, _ = P.modal_impact('bronze_bell', dur=0.60, hardness=0.85, size_scale=0.22, seed=32)
        r_bell_blade = J.judge_wave(_norm_peak(bell_bright), D.SR, 'metal_blade')
        self.assertTrue(r_bell_blade['ok'], r_bell_blade)
        self.assertEqual([r for r in r_bell_blade['reasons'] if 'hf_' in r], [], r_bell_blade)
        self.assertGreater(r_bell_blade['metrics']['hf_whistle_db'], 20.0, r_bell_blade)

        bell_deep, _ = P.modal_impact('bronze_bell', dur=0.70, hardness=0.75, size_scale=0.75, seed=33)
        r_bell_tonal = J.judge_wave(_norm_peak(bell_deep), D.SR, 'sustained_tonal')
        self.assertTrue(r_bell_tonal['ok'], r_bell_tonal)
        self.assertEqual(r_bell_tonal['status'], 'pass', r_bell_tonal)

        # 3) 晶莹界面提示音（tonal_ui，含 6.4 kHz 与 9.6 kHz 合法泛音尖峰）
        t_ui = np.arange(D.N(0.32)) / D.SR
        env_ui = np.minimum(1.0, t_ui / 0.006) * np.exp(-t_ui / 0.085)
        ui_chime = _norm_peak((
            0.55 * np.sin(2.0 * np.pi * 1600.0 * t_ui)
            + 0.32 * np.sin(2.0 * np.pi * 6400.0 * t_ui)
            + 0.22 * np.sin(2.0 * np.pi * 9600.0 * t_ui)
        ) * env_ui)
        r_ui = J.judge_wave(ui_chime, D.SR, 'tonal_ui')
        self.assertTrue(r_ui['ok'], r_ui)
        self.assertEqual(r_ui['status'], 'pass', r_ui)
        self.assertGreater(r_ui['metrics']['hf_whistle_db'], 25.0, r_ui)

        # 4) 无源弹簧与棘轮机构（mechanical）
        spring, _ = F.spring_coil(0.38, turns=12, action='release', key='D', seed=34)
        r_mech = J.judge_wave(_norm_peak(spring), D.SR, 'mechanical')
        self.assertTrue(r_mech['ok'], r_mech)
        self.assertEqual(r_mech['status'], 'pass', r_mech)

    def test_short_duration_low_samplerate_and_stopband_guards(self):
        """短脉冲（<85ms / <1024 有效样本）、低采样率（<16 kHz / <12 kHz）与深低通阻带边界保护，不产生伪尖刺。"""
        rng = np.random.default_rng(99)
        # 1) 低采样率保护
        x_8k = rng.standard_normal(4000) * 0.4
        m_8k = J.extract_metrics(x_8k, 8000)
        self.assertEqual(m_8k['hf_envelope_buzz'], 0.0)
        self.assertEqual(m_8k['hf_whistle_db'], 0.0)

        # 2) 超短瞬态（有效时长 12 ms < 85 ms，有效样本 < 1024）
        short = np.zeros(D.N(0.20))
        m_len = D.N(0.010)
        short[D.N(0.03):D.N(0.03) + m_len] = rng.standard_normal(m_len) * np.hanning(m_len) * 0.6
        m_short = J.extract_metrics(short, D.SR)
        self.assertEqual(m_short['hf_envelope_buzz'], 0.0)
        self.assertEqual(m_short['hf_whistle_db'], 0.0)

        # 3) 深低通体感信号（>4 kHz 处于阻带底噪）：floor_db 钳位防止微弱阻带纹波变成假 60 dB 哨音
        sub = _norm_peak(D.lp(rng.standard_normal(D.N(0.8)), 320.0, 4) * np.hanning(D.N(0.8)))
        m_sub = J.extract_metrics(sub, D.SR)
        self.assertEqual(m_sub['hf_envelope_buzz'], 0.0)
        self.assertLess(m_sub['hf_whistle_db'], 3.0)

    def test_archetype_contract_and_multi_rate_buzz_coverage(self):
        """核对宽带非乐音与乐音/金属/机械原型的门限配置边界，并覆盖 45 Hz / 360 Hz 调制嗡声与高频哨音拦截。"""
        broadband_archs = ('friction_cloth', 'whoosh', 'water', 'ambience', 'foley_snap', 'impact', 'wood')
        exempt_archs = ('metal_blade', 'sustained_tonal', 'tonal_ui', 'low_drone', 'mechanical')
        for arch in broadband_archs:
            self.assertIn('hf_buzz_max', J.ARCHETYPES[arch], arch)
            self.assertIn('hf_whistle_max_db', J.ARCHETYPES[arch], arch)
        for arch in exempt_archs:
            self.assertNotIn('hf_whistle_max_db', J.ARCHETYPES[arch], arch)
            self.assertNotIn('hf_buzz_max', J.ARCHETYPES[arch], arch)

        rng = np.random.default_rng(77)
        dur = 0.45
        n = D.N(dur)
        t = np.arange(n) / D.SR
        env = np.sin(np.pi * t / dur) ** 1.2
        body = D.bp(rng.standard_normal(n), 280.0, 4400.0, 2) * 0.26
        for f_mod in (45.0, 360.0):
            mod = (0.5 + 0.5 * np.cos(2.0 * np.pi * f_mod * t)) ** 2.0
            hi = D.hp(rng.standard_normal(n), 6600.0, 4) * mod * 0.40
            sig = _norm_peak((body + hi) * env)
            res = J.judge_wave(sig, D.SR, 'water' if f_mod < 100.0 else 'ambience')
            self.assertFalse(res['ok'], f'f_mod={f_mod} Hz 未被拒收: {res}')
            self.assertGreater(res['metrics']['hf_envelope_buzz'], 0.65, res)
            self.assertTrue(any('hf_envelope_buzz' in r for r in res['reasons']), res)


if __name__ == '__main__':
    unittest.main()
