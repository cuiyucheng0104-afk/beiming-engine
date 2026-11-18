# -*- coding: utf-8 -*-
"""鸽群真实翼音采样模式 audio/design.py（pigeons sample_path）的立体声确定性与切片能量归一测试。"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from audio.design import _wing_sample, pigeons  # noqa: E402
from engine.audio.dsp import SR, rng, rms  # noqa: E402


class PigeonSamplingTests(unittest.TestCase):
    def test_real_sample_mode_is_stereo_deterministic_and_keeps_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'wing.wav'
            t = np.arange(int(SR * 0.08)) / SR
            sf.write(path, np.stack([np.sin(2 * np.pi * 900 * t)] * 2, axis=1), SR)

            first = pigeons(sample_path=path, seed=303, n_birds=2, d=0.5)
            second = pigeons(sample_path=path, seed=303, n_birds=2, d=0.5)

        self.assertEqual(first[0].shape, (int(SR * 0.5), 2))
        np.testing.assert_array_equal(first[0], second[0])
        np.testing.assert_array_equal(first[1], second[1])
        self.assertGreater(np.max(np.abs(first[0])), 0)

    def test_active_region_slicing_normalizes_each_flap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'wing.wav'
            x = np.zeros(int(SR * 0.3))
            a, b = int(SR * 0.04), int(SR * 0.16)
            c, d = int(SR * 0.20), int(SR * 0.28)
            t = np.arange(b - a) / SR
            x[a:b] = 0.1 * np.sin(2 * np.pi * 800 * t)
            x[c:d] = 0.4 * np.sin(2 * np.pi * 1200 * np.arange(d - c) / SR)
            sf.write(path, x, SR)

            flaps = [_wing_sample(path, rng(i), 1.0) for i in range(12)]

        self.assertTrue(any(len(f) <= int(SR * 0.14) for f in flaps))
        for flap in flaps:
            self.assertAlmostEqual(rms(flap), 0.96, delta=0.16)


if __name__ == '__main__':
    unittest.main()
