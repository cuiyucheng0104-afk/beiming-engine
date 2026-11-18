# -*- coding: utf-8 -*-
"""真实录音音效库 engine/audio/library.py 单元测试：48 kHz 保音高重采样、半音移调、起音静音裁剪、等功率底噪循环、翼音切片封顶与滤波。"""
import os
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import library as L  # noqa: E402
from engine.audio.dsp import SR, N  # noqa: E402


def tone(sec, freq=1000.0, rate=SR, amp=0.5):
    t = np.arange(int(rate * sec)) / rate
    return amp * np.sin(2 * np.pi * freq * t)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lambda: L.use_manifest({}, ''))

    def lib(self, sounds, files):
        for i, (x, rate) in files.items():
            sf.write(self.dir / f'{i}.wav', x, rate)
        L.use_manifest(sounds, str(self.dir))

    def test_inactive_library_returns_none(self):
        L.use_manifest({}, '')
        self.assertIsNone(L.get('horn'))
        self.assertIsNone(L.file('horn'))

    def test_missing_file_fails_loudly(self):
        self.lib({'a': {'id': 1}}, {})
        with self.assertRaises(FileNotFoundError):
            L.get('a')

    def test_non_48k_file_keeps_pitch(self):
        self.lib({'a': {'id': 1}}, {1: (tone(1.0, 1000.0, 44100), 44100)})
        x = L.get('a', mono=True)
        spec = np.abs(np.fft.rfft(x))
        self.assertAlmostEqual(np.argmax(spec) * SR / len(x), 1000.0, delta=3.0)
        self.assertAlmostEqual(len(x) / SR, 1.0, delta=0.01)

    def test_semitones_down_an_octave_doubles_length(self):
        self.lib({'a': {'id': 1, 'semitones': -12}}, {1: (tone(0.5), SR)})
        self.assertAlmostEqual(len(L.get('a')) / SR, 1.0, delta=0.02)

    def test_one_shot_trims_leading_silence(self):
        x = np.concatenate([np.zeros(N(0.5)), tone(0.2)])
        self.lib({'a': {'id': 1}}, {1: (x, SR)})
        y = L.get('a', mono=True)
        self.assertLess(int(np.argmax(np.abs(y) > 0.05)), N(0.01))

    def test_bed_loops_to_exact_length_without_click(self):
        self.lib({'a': {'id': 1}}, {1: (tone(0.3, 800.0), SR)})
        y = L.get('a', dur=1.0, mono=True)
        self.assertEqual(len(y), N(1.0))
        self.assertLess(np.max(np.abs(np.diff(y))), 0.2)

    def test_stereo_by_default_and_mono_on_request(self):
        self.lib({'a': {'id': 1}}, {1: (tone(0.2), SR)})
        self.assertEqual(L.get('a').ndim, 2)
        self.assertEqual(L.get('a', mono=True).ndim, 1)

    def test_slices_are_capped_and_each_flap_separate(self):
        x = np.zeros(N(1.0))
        for a in (0.1, 0.5):
            x[N(a):N(a) + N(0.06)] = tone(0.06)
        x[N(0.8):] = 0.3 * np.random.default_rng(0).standard_normal(N(0.2))
        self.lib({'a': {'id': 1}}, {1: (x, SR)})
        s = L.slices(L.file('a'))
        self.assertGreaterEqual(len(s), 2)
        self.assertTrue(all(len(p) <= N(0.12) for p in s))

    def test_continuous_noise_cannot_make_one_giant_flap(self):
        x = 0.3 * np.random.default_rng(1).standard_normal(N(20.0))
        self.lib({'a': {'id': 1}}, {1: (x, SR)})
        self.assertTrue(all(len(p) <= N(0.12) for p in L.slices(L.file('a'))))

    def test_lp_and_hp_shape_the_band(self):
        low, high = tone(0.5, 200.0), tone(0.5, 4000.0)
        self.lib({'a': {'id': 1, 'hp': 1000}, 'b': {'id': 1, 'lp': 1000}}, {1: (low + high, SR)})
        loud = lambda x, f: np.abs(np.fft.rfft(x))[int(f * len(x) / SR)]  # noqa: E731
        hp_x, lp_x = L.get('a', mono=True), L.get('b', mono=True)
        self.assertLess(loud(hp_x, 200.0), 0.1 * loud(hp_x, 4000.0))
        self.assertLess(loud(lp_x, 4000.0), 0.1 * loud(lp_x, 200.0))

    def test_silent_file_is_rejected(self):
        self.lib({'a': {'id': 1}}, {1: (np.zeros(N(0.5)), SR)})
        with self.assertRaises(ValueError):
            L.get('a')


if __name__ == '__main__':
    unittest.main()
