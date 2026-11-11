# -*- coding: utf-8 -*-
"""长片音频 engine/audio/stream.py：分块的测量与母带与整段算法一致，float32 稀疏总线的误差在 1e-7 量级，内存随片长近似不涨。

  · 分块积分响度 / 真峰值 = meter 的整段计算（差 < 1e-9）；块大小随便切（7.3 秒、1 秒、不整除）结果都一样；
  · 分块限制器 = dsp.tp_limit（逐样本差 < 1e-10，实测约 1e-12：分块只改变均值滤波的求和顺序）；分块 loudness_to = mixing.loudness_to（总增益差 < 1e-6 dB，样本差 < 1e-9）；
  · Bus.place（float64 总线）与 mixing.at 逐样本相同；float32 总线与 float64 的差 ≤ 1e-7（说明：float32 有 24 位尾数，
    满幅附近一个最低位约 6e-8，比 24 bit PCM 的量化步长 1.2e-7 还小）；
  · bed 长底层确定（同种子同结果），交叉处总功率不塌（等功率交叉，白噪声底层的交叉段与两侧差 < 0.5 dB）；
  · 内存：tests/audio/longmix_probe.py 合成整条混音（三层底层、几百个音效、旁白让路、分块母带、写盘），60 秒与 180 秒两次的峰值
    内存差按秒算的斜率 × 600 秒加上 180 秒的读数要 < 1.5 GB；设 BEIMING_TEST_SLOW=1 时另外真跑 600 秒（约 30 秒、临时写约 0.9 GB）。
"""
import json
import os
import shutil
import unittest

import numpy as np

import _audiotest as H
from engine.audio import dsp, meter as M, mixing, stream as S

GB = 1024.0


def probe(seconds):
    td = H.tmpdir('longmix')
    try:
        r = H.run(['python', os.path.join(H.HERE, 'longmix_probe.py'), td, str(seconds)], timeout=1800)
        if r.returncode != 0:
            raise AssertionError(f'longmix_probe 退出码 {r.returncode}：{r.stderr[-1500:]}')
        return json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        shutil.rmtree(td, ignore_errors=True)


class Equivalence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.x = H.music_like(25.3, seed=11) * 0.4

    def test_loudness_and_true_peak_in_any_chunking(self):
        whole_i, whole_tp = M.integrated(self.x), M.true_peak(self.x)
        for size in (H.N(7.3), H.N(1.0), 12345):
            L, tp = S.Loudness(), S.TruePeak(4)
            for a in range(0, len(self.x), size):
                L.feed(self.x[a:a + size])
                tp.feed(self.x[a:a + size])
            tp.finish()
            self.assertAlmostEqual(L.integrated(), whole_i, delta=1e-9, msg=f'块 {size}')
            self.assertAlmostEqual(tp.value, whole_tp, delta=1e-12, msg=f'块 {size}')
        m = S.measure(self.x, chunk_s=3.7)
        self.assertAlmostEqual(m['integrated'], whole_i, delta=1e-9)

    def test_limiter_matches_tp_limit(self):
        hot = self.x * 4.0
        ref, _ = dsp.tp_limit(hot.copy(), -1.0, look=0.004, rel=0.10)
        y = hot.copy()
        S.limit(y, -1.0, look=0.004, rel=0.10, chunk_s=3.3)
        self.assertLess(float(np.abs(y - ref).max()), 1e-10)      # 分块只改变均值滤波的求和顺序（实测约 1e-12）

    def test_loudness_to_matches_mixing(self):
        ref, g_ref, _ = mixing.loudness_to(self.x.copy(), -14.0, -1.0)
        y = self.x.copy()
        g, st = S.loudness_to(y, -14.0, -1.0, chunk_s=4.1)
        self.assertAlmostEqual(g, g_ref, delta=1e-6)
        self.assertLess(float(np.abs(y - ref).max()), 1e-9)
        self.assertAlmostEqual(M.integrated(y), -14.0, delta=0.03)
        self.assertLessEqual(20 * np.log10(M.true_peak(y)), -1.0 + 0.01)

    def test_sparse_place_matches_mixing_at(self):
        n = H.N(12.0)
        from engine.audio.synth import glass_tone
        clips = [(glass_tone(440 * (1 + i / 7), 1.0, 0.3) * 0.3, 0.37 + i * 1.13, (i % 5 - 2) / 3) for i in range(9)]
        ref = np.zeros((n, 2))
        for x, t, pan in clips:
            ref += mixing.at(dsp.stereo(x, pan), t, n)
        b64 = S.Bus(n, dtype=np.float64)
        b32 = S.Bus(n)
        for x, t, pan in clips:
            b64.place(x, t, pan=pan)
            b32.place(x, t, pan=pan)
        self.assertEqual(float(np.abs(b64.buf - ref).max()), 0.0)
        self.assertLessEqual(float(np.abs(b32.buf.astype(np.float64) - ref).max()), 1e-7)
        self.assertEqual(b32.buf.dtype, np.float32)

    def test_bed_deterministic_and_seamless(self):
        n = H.N(50.0)

        def make(d, seed):                # 白噪声：0.25 秒的电平本身很稳（±0.1 dB），交叉处塌不塌看得清
            return dsp.rng(seed).standard_normal((H.N(d), 2)) * 0.1
        b1, b2 = S.Bus(n), S.Bus(n)
        S.bed(b1, make, 0, 50, seg=20, xf=1.0, seed=3)
        S.bed(b2, make, 0, 50, seg=20, xf=1.0, seed=3)
        self.assertTrue(np.array_equal(b1.buf, b2.buf))
        x = b1.buf.astype(np.float64)
        rms = [float(np.sqrt(np.mean(x[a:a + H.N(0.25)] ** 2))) for a in range(H.N(1), n - H.N(1.25), H.N(0.25))]
        self.assertLess(20 * np.log10(max(rms) / min(rms)), 1.0, '0.25 秒电平起伏（含交叉处）')
        seams = [19.0, 38.0]              # 第二段从 19 秒起交叉、第三段从 38 秒起
        for s in seams:
            a, b = H.N(s), H.N(s + 1.0)
            mid = float(np.sqrt(np.mean(x[a:b] ** 2)))
            around = float(np.sqrt(np.mean(np.concatenate([x[a - H.N(2):a], x[b:b + H.N(2)]]) ** 2)))
            self.assertLess(abs(20 * np.log10(mid / around)), 0.5, f'{s} 秒处的交叉')


class Memory(unittest.TestCase):
    def test_ten_minute_mix_memory_budget(self):
        a, b = probe(60), probe(180)
        for p in (a, b):
            self.assertAlmostEqual(p['integrated'], -14.0, delta=0.05)
            self.assertLessEqual(p['truePeakDb'], -1.0 + 0.01)
        slope = max(0.0, (b['peakRssMb'] - a['peakRssMb']) / 120.0)          # MB / 秒
        est = b['peakRssMb'] + slope * 420.0
        self.assertLess(est, 1.5 * GB, f'按 60 / 180 秒推到 600 秒约 {est:.0f} MB（{a["peakRssMb"]} → {b["peakRssMb"]} MB）')

    @unittest.skipUnless(os.environ.get('BEIMING_TEST_SLOW') == '1', '真跑 10 分钟混音：设 BEIMING_TEST_SLOW=1')
    def test_ten_minute_mix_real(self):
        p = probe(600)
        self.assertLess(p['peakRssMb'], 1.5 * GB, p)
        self.assertAlmostEqual(p['integrated'], -14.0, delta=0.05)


if __name__ == '__main__':
    unittest.main()
