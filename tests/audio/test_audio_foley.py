# -*- coding: utf-8 -*-
"""物理拟音层 engine/audio/foley.py、library.sync_anchor 与 dsp.{space_place, doppler} 单元测试。"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import foley as F, library as L  # noqa: E402
from engine.audio.dsp import SR, N, T, rng, space_place, doppler, rms  # noqa: E402


class FoleyAndSpatialTests(unittest.TestCase):
    def test_sync_anchor_separates_pre_whoosh_from_impact(self):
        """带 90 ms 渐起破空 + 0.095 s 处陡峭撞击的复合录音：P-Center 锚点必须落在 0.095 s ± 3 ms，而非开头 5% 处。"""
        t = T(0.30)
        whoosh = 0.22 * np.sin(2 * np.pi * 420 * t) * np.clip(t / 0.09, 0.0, 1.0) * (t < 0.095)
        hit_t = 0.095
        dt = np.maximum(0.0, t - hit_t)
        impact = (t >= hit_t) * 0.95 * np.sin(2 * np.pi * 2400 * dt) * np.exp(-dt / 0.015)
        x = whoosh + impact
        anc = L.sync_anchor(x, SR)
        self.assertAlmostEqual(anc, hit_t, delta=0.003)

    def test_lossless_file_preferred_over_mp3(self):
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            t = T(0.1)
            sf.write(d / '42.wav', 0.5 * np.sin(2 * np.pi * 880 * t), SR)
            (d / '42.mp3').write_bytes(b'fake-mp3-not-picked')
            L.use_manifest({'hit': {'id': 42}}, str(d))
            self.assertTrue(L.file('hit').endswith('42.wav'))
            L.use_manifest({}, '')

    def test_place_anchored_lands_composite_impact_on_exact_frame(self):
        """water_cleave 含 160 ms 前导破空，用 place_anchored 对齐到 1.000 s 后，能量主冲击峰精确落在 1.000 s 附近。"""
        wave, anc = F.water_cleave(dur=1.2, force=1.0, seed=11)
        self.assertGreater(anc, 0.10, '前导破空应在冲击点之前')
        buf = np.zeros((N(2.5), 2))
        F.place_anchored(buf, wave, 1.0, anchor=anc)
        # 检查 0.85..0.98s 有前导声，而高频瞬态能量峰落在 1.000 s ± 6 ms
        pre_rms = rms(buf[N(0.88):N(0.96)])
        self.assertGreater(pre_rms, 1e-3)
        hi = np.diff(buf.mean(1), prepend=0.0) ** 2
        win = N(0.004)
        env = np.convolve(hi, np.ones(win) / win, 'same')
        t_pk = float(np.argmax(env[N(0.8):N(1.2)]) + N(0.8)) / SR
        self.assertAlmostEqual(t_pk, 1.0, delta=0.008)

    def test_round_robin_deck_never_repeats_adjacent_clip(self):
        clips = [np.sin(2 * np.pi * (400 + 200 * k) * T(0.04)) for k in range(4)]
        deck = F.RoundRobinDeck(clips, seed=19, pitch_st=1.0, eq_db=1.2)
        picks = [deck.draw(velocity=1.0)[3] for _ in range(32)]
        for a, b in zip(picks, picks[1:]):
            self.assertNotEqual(a, b, f'相邻两次抽到了同一条切片：{picks}')

    def test_shift_material_preserves_high_frequency_msi_on_octave_drop(self):
        """大幅降调（-10 半音）时，真实录音原本到 8.5 kHz 的表面接触脆度会被压到 4.8 kHz 以下；preserve_msi 能恢复 5.2 kHz 以上的材质瞬态。"""
        from engine.audio.dsp import lp
        r = rng(23)
        t = T(0.12)
        click = lp(np.exp(-t / 0.004) * r.standard_normal(len(t)), 8500.0, 4)
        plain = F.shift_material(click, -10.0, preserve_msi=0.0)
        kept = F.shift_material(click, -10.0, preserve_msi=0.7)
        spec_plain = np.abs(np.fft.rfft(plain))
        spec_kept = np.abs(np.fft.rfft(kept))
        freqs = np.fft.rfftfreq(len(kept), 1 / SR)
        hi_plain = float(np.sum(spec_plain[freqs > 5200] ** 2))
        hi_kept = float(np.sum(spec_kept[freqs > 5200] ** 2))
        self.assertGreater(hi_kept, hi_plain * 4.0)

    def test_space_place_distance_dr_ratio_and_mono_compatibility(self):
        """space_place：远处比近处高频更暗、混响湿比更高；极左/极右摆位折单声道相关性仍 ≥ 0（不触发反相门禁）。"""
        t = T(0.08)
        src = np.exp(-t / 0.015) * rng(31).standard_normal(len(t))

        b_near, w_near = np.zeros((N(1.6), 2)), np.zeros((N(1.6), 2))
        b_far, w_far = np.zeros((N(1.6), 2)), np.zeros((N(1.6), 2))
        space_place(b_near, src, 0.1, pan=-0.85, dist=0.8, ref_dist=2.0, wet=0.25, wet_buf=w_near)
        space_place(b_far, src, 0.1, pan=-0.85, dist=12.0, ref_dist=2.0, wet=0.25, wet_buf=w_far)

        dr_near = rms(b_near) / max(rms(w_near), 1e-12)
        dr_far = rms(b_far) / max(rms(w_far), 1e-12)
        self.assertGreater(dr_near, dr_far * 2.5, '近处直达/混响比应显著高于远处')

        # 折单声道相关性与能量检查（微双耳时差 ≤ 0.28ms 不应造成反相抵消）
        seg = b_near[N(0.09):N(0.22)]
        corr = float(np.dot(seg[:, 0], seg[:, 1]) / (np.linalg.norm(seg[:, 0]) * np.linalg.norm(seg[:, 1]) + 1e-20))
        self.assertGreaterEqual(corr, 0.0)

    def test_doppler_shifts_pitch_up_approaching_and_down_receding(self):
        """34.3 m/s（0.1 马赫）逼近升调约 +10%，远离降调约 -10%。"""
        f0 = 1000.0
        x = np.sin(2 * np.pi * f0 * T(0.6))
        app = doppler(x, vel_mps=34.3, c_sound=343.0)[N(0.15):N(0.55)]
        rec = doppler(x, vel_mps=-34.3, c_sound=343.0)[N(0.15):N(0.55)]
        f_app = np.argmax(np.abs(np.fft.rfft(app))) * SR / len(app)
        f_rec = np.argmax(np.abs(np.fft.rfft(rec))) * SR / len(rec)
        self.assertAlmostEqual(f_app, 1100.0, delta=8.0)
        self.assertAlmostEqual(f_rec, 900.0, delta=8.0)

    def test_precision_mechanical_primitives_and_micro_to_macro_caricature(self):
        """精密刚体拟音原语：粘滑摩擦、螺纹旋松、色散弹簧与微距→巨物化棘齿卡扣（1.0x vs 4.2x 低频体量放大且不丢 >3kHz 瞬态）。"""
        fric = F.stick_slip_friction(0.25, np.linspace(0.2, 1.0, 60), material='polymer', seed=3)
        self.assertEqual(len(fric), N(0.25))
        self.assertGreater(rms(fric[-N(0.08):]), rms(fric[:N(0.06)]))

        unscrew, u_anc = F.helical_thread(0.30, turns=6.5, direction='unscrew', seed=5)
        screw, s_anc = F.helical_thread(0.24, turns=6.5, direction='screw', seed=6)
        self.assertLess(u_anc, 0.10)
        self.assertGreater(s_anc, 0.15)
        self.assertGreater(rms(screw), 0.05)

        sp_rel, _ = F.spring_coil(0.35, turns=12, action='release', key='D', seed=9)
        self.assertGreater(rms(sp_rel), 0.05)

        ka_micro, anc_m = F.ratchet_detent(scale=1.0, variant='ka', key='D', seed=11)
        ka_macro, anc_g = F.ratchet_detent(scale=4.2, variant='ka', key='D', seed=11)
        self.assertGreater(len(ka_macro), len(ka_micro))
        # 4.2x 巨物化的 35–140 Hz 超低频能量占比显著高于 1.0x 微距版，同时仍保留 >3kHz 齿尖脆度
        sp_m = np.abs(np.fft.rfft(ka_micro.mean(1))) ** 2
        sp_g = np.abs(np.fft.rfft(ka_macro.mean(1))) ** 2
        fq_m = np.fft.rfftfreq(len(ka_micro), 1 / SR)
        fq_g = np.fft.rfftfreq(len(ka_macro), 1 / SR)
        sub_ratio_m = float(sp_m[(fq_m >= 35) & (fq_m <= 140)].sum() / (sp_m.sum() + 1e-20))
        sub_ratio_g = float(sp_g[(fq_g >= 35) & (fq_g <= 140)].sum() / (sp_g.sum() + 1e-20))
        hi_ratio_g = float(sp_g[fq_g >= 3000].sum() / (sp_g.sum() + 1e-20))
        self.assertGreater(sub_ratio_g, sub_ratio_m * 3.0)
        self.assertGreater(hi_ratio_g, 0.01)

    def test_micro_slices_and_composite_mechanism_recipe(self):
        """library.slices(min_len=0.0025) 可切出 6 ms 级圆珠笔连续咔嗒；composite_mechanism 精确对齐认知锚点与棘轮底盘。"""
        r = rng(71)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / 'multi_pen.wav'
            seq = np.zeros(N(0.65))
            for at in (0.06, 0.22, 0.39, 0.54):
                i0 = N(at)
                m = N(0.007)
                seq[i0:i0 + m] += 0.85 * np.exp(-np.arange(m) / (SR * 0.0016)) * r.standard_normal(m)
            sf.write(p, seq, SR)
            # 默认 min_len=0.025 过滤超短瞬态，而传 min_len=0.0025 完整切出 4 下独立按压
            sl_micro = L.slices(str(p), max_len=0.08, gate=0.12, min_len=0.0025)
            self.assertEqual(len(sl_micro), 4)

            mech_sample = 0.7 * np.exp(-T(0.05) / 0.008) * r.standard_normal(N(0.05))
            comp, anc = F.composite_mechanism(
                identity=sl_micro[0],
                mechanism=mech_sample,
                latch_body=mech_sample,
                scale=3.2,
                identity_pitch_st=-4.5,
                preserve_msi=0.85,
                tube_mm=136.0,
                bounce_ms=16.0,
                seed=15,
            )
            buf = np.zeros((N(0.8), 2))
            F.place_anchored(buf, comp, 0.35, anchor=anc)
            pk_t = float(np.argmax(np.abs(buf.mean(1)))) / SR
            self.assertAlmostEqual(pk_t, 0.35, delta=0.006)

            # 无源精密齿轮转动 + 落锁咬合：前段逐齿拨动清脆推进，落锁锚点能量显著高于前导转动
            gear_w, gear_anc = F.precision_gear_turn(0.14, teeth=5, tooth_sample=sl_micro[0], lock_sample=mech_sample, seed=21)
            self.assertAlmostEqual(gear_anc, 0.14, delta=0.002)
            self.assertGreater(rms(gear_w[N(0.135):N(0.165)]), rms(gear_w[:N(0.11)]) * 1.6)


if __name__ == '__main__':
    unittest.main()
