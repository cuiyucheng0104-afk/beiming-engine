# -*- coding: utf-8 -*-
"""engine/audio 的回归测试（只用合成信号和临时文件，不需要采样库）。

用法（仓库根）：python -m unittest engine.audio.test_audio
需要 numpy / scipy / numba / soundfile / soxr / pillow；用到 ffmpeg 的几条在找不到 ffmpeg 时跳过。
"""
import os
import shutil
import subprocess
import tempfile
import unittest
import warnings
from unittest import mock

# numba 的 cache=True 会把编译缓存写进 engine/audio/__pycache__：import dsp 之前把缓存目录指到系统临时目录，
# 与 audio/test_check.py、audio/test_timeline.py 的做法一致
os.environ.setdefault('NUMBA_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'beiming-numba-cache'))

import numpy as np

from engine.audio import meter, mixing, sampler, scope
from engine.audio.dsp import SR, N, undb, tp_limit

HAS_FFMPEG = shutil.which('ffmpeg') is not None


def _noise(sec, seed):
    return np.random.default_rng(seed).standard_normal((N(sec), 2))


def _block_lufs(x):
    """K 加权后整段的均方响度（不门限），用来把测试信号校准到指定 LUFS"""
    k = meter.kweight(x)
    return -0.691 + 10 * np.log10(np.sum(np.mean(k ** 2, axis=0)))


def _at_lufs(x, lufs):
    return x * undb(lufs - _block_lufs(x))


def _ref_integrated(st):
    """BS.1770-4 参考实现：400 ms 块、75% 重叠，块要同时高于 −70 绝对门限与相对门限"""
    k = meter.kweight(st)
    p = np.sum(k ** 2, axis=1)
    W, H = N(0.4), N(0.1)
    z = np.array([p[s:s + W].mean() for s in range(0, len(p) - W + 1, H)])
    lz = -0.691 + 10 * np.log10(z + 1e-12)
    za = z[lz > -70]
    rel = -0.691 + 10 * np.log10(za.mean()) - 10
    return -0.691 + 10 * np.log10(z[(lz > -70) & (lz > rel)].mean())


class TestIntegratedGate(unittest.TestCase):
    """R53：相对门限之外还要同时满足 −70 绝对门限"""

    def test_weak_signal_uses_both_gates(self):
        x = np.concatenate([_at_lufs(_noise(2, 1), -64.0), _at_lufs(_noise(8, 2), -72.0)])
        got, ref = meter.integrated(x), _ref_integrated(x)
        self.assertAlmostEqual(ref, -64.28, delta=0.05)
        self.assertAlmostEqual(got, ref, delta=0.01, msg=f'integrated={got:.2f}，BS.1770-4 应为 {ref:.2f}')

    def test_normal_levels_unchanged(self):
        x = np.concatenate([_at_lufs(_noise(4, 3), -20.0), _at_lufs(_noise(6, 4), -28.0)])
        self.assertAlmostEqual(meter.integrated(x), _ref_integrated(x), delta=0.01)

    def test_silence_is_minus_inf(self):
        self.assertEqual(meter.integrated(np.zeros((N(2), 2))), -np.inf)


class TestMatchLevel(unittest.TestCase):
    """R48：测量区间里没有信号时给出看得懂的 ValueError，不再算出 ±inf 增益、把总线变成 NaN"""

    def test_win_on_silence_raises(self):
        st = np.zeros((N(3), 2))
        st[N(2.5):] = _noise(0.5, 5)[:N(3) - N(2.5)] * 0.1          # 信号在 2.5 s 之后，测量区间 0.5–2.0 s 是静音
        with self.assertRaisesRegex(ValueError, '没有可测的信号'):
            mixing.match_level(st, -30.0, 'win', 0.5, 2.0)

    def test_win_too_short_raises(self):
        with self.assertRaisesRegex(ValueError, '短于 0.4 s'):
            mixing.match_level(_noise(2, 6) * 0.1, -30.0, 'win', 1.0, 1.3)

    def test_mom_without_full_window_raises(self):
        with self.assertRaisesRegex(ValueError, '0.4 s'):
            mixing.match_level(_noise(0.3, 7) * 0.1, -30.0, 'mom')

    def test_peak_on_zeros_raises(self):
        with self.assertRaisesRegex(ValueError, '全是 0'):
            mixing.match_level(np.zeros((N(1), 2)), -17.0, 'peak')

    def test_normal_case_unchanged(self):
        st = _noise(2, 8) * 0.1
        out, cur, g = mixing.match_level(st, -30.0, 'win', 0.2, 1.8)
        self.assertTrue(np.isfinite(out).all())
        self.assertAlmostEqual(meter.integrated(out[N(0.2):N(1.8)]), -30.0, delta=0.01)
        self.assertAlmostEqual(g, -30.0 - cur, places=12)


class TestLoudnessTo(unittest.TestCase):
    """R54：返回的总增益就是作用在返回音频上的那一个；不收敛给 RuntimeWarning；iters < 1 报错。R48：静音输入报错"""

    def _sine(self, amp=0.5, sec=4.0):
        t = np.arange(N(sec)) / SR
        return np.stack([amp * np.sin(2 * np.pi * 220 * t)] * 2, 1)

    def test_returned_gain_matches_applied_when_not_converged(self):
        mix = self._sine()
        with self.assertWarns(RuntimeWarning):
            lim, g, gr = mixing.loudness_to(mix, -2.0, -1.7)         # 正弦被限制器钉死，−2 LUFS 达不到
        lim2, _ = tp_limit(mix * undb(g), -1.7, look=0.005, rel=0.12)
        self.assertTrue(np.array_equal(lim, lim2), '返回的 g 和实际作用在 lim 上的增益不一致')

    def test_converged_case(self):
        mix = _noise(4, 9) * 0.05
        with warnings.catch_warnings():
            warnings.simplefilter('error')
            lim, g, gr = mixing.loudness_to(mix, -20.0, -1.0)
        self.assertLess(abs(meter.integrated(lim) + 20.0), 0.03)
        self.assertTrue(np.array_equal(lim, tp_limit(mix * undb(g), -1.0, look=0.005, rel=0.12)[0]))

    def test_iters_zero_raises(self):
        with self.assertRaises(ValueError):
            mixing.loudness_to(_noise(2, 10) * 0.1, -14.0, -1.7, iters=0)

    def test_silence_raises(self):
        with self.assertRaisesRegex(ValueError, '没有可测的信号'):
            mixing.loudness_to(np.zeros((N(2), 2)), -14.0, -1.7)


class TestSamplerVelocity(unittest.TestCase):
    """R46：音名 F2/F3/F4 小写后是 f2…，不能被当成力度记号 f（forte）"""

    LIB = {
        'vsco2ce/Strings/Cello Section/susvib': ['susvib_A2_v1_1', 'susvib_A2_v3_1', 'susvib_F2_v1_1', 'susvib_F2_v3_1',
                                                'susvib_F4_v1_1', 'susvib_F4_v3_1', 'susvib_D4_v1_1', 'susvib_D4_v3_1'],
        'vsco2ce/Strings/Viola Section/susvib': ['ViolaEns_susvib_F3_v1_1', 'ViolaEns_susvib_F3_v2_1', 'ViolaEns_susvib_A3_v2_1'],
        'vcsl/Chordophones/Composite Chordophones/Concert Harp': ['KSHarp_A2_f1', 'KSHarp_A2_mf1', 'KSHarp_F4_f1', 'KSHarp_F4_mf1'],
    }

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='beiming-samples-')
        for rel, names in self.LIB.items():
            os.makedirs(os.path.join(self.tmp, rel))
            for n in names:
                open(os.path.join(self.tmp, rel, n + '.flac'), 'wb').close()     # _zones 只看文件名
        self._root, self._cache = sampler.ROOT, dict(sampler._cache)
        sampler.ROOT = self.tmp
        sampler._cache.clear()

    def tearDown(self):
        sampler.ROOT = self._root
        sampler._cache.clear()
        sampler._cache.update(self._cache)
        shutil.rmtree(self.tmp)

    def test_parse_stem(self):
        self.assertEqual(sampler._parse_stem('KSHarp_F4_mf1'), ('F4', 6.0))
        self.assertEqual(sampler._parse_stem('KSHarp_F4_f1'), ('F4', 7.5))
        self.assertEqual(sampler._parse_stem('KSHarp_A2_f1'), ('A2', 7.5))
        self.assertEqual(sampler._parse_stem('ViolaEns_susvib_F3_v1_1'), ('F3', 1))
        self.assertEqual(sampler._parse_stem('susvib_F4_v3_1'), ('F4', 3))
        self.assertEqual(sampler._parse_stem('susvib_F#4_v3_1'), ('F#4', 3))

    def zones(self, inst):
        return {os.path.basename(z['file'])[:-5]: z['vel'] for z in sampler._zones(inst)}

    def test_cello_layers(self):
        v = self.zones('cellos')
        for n in ['A2', 'F2', 'F4', 'D4']:
            self.assertEqual(v[f'susvib_{n}_v1_1'], 0.0, n)
            self.assertEqual(v[f'susvib_{n}_v3_1'], 1.0, n)

    def test_viola_layers(self):
        v = self.zones('violas')
        self.assertEqual(v['ViolaEns_susvib_F3_v1_1'], 0.0)
        self.assertEqual(v['ViolaEns_susvib_F3_v2_1'], 1.0)

    def test_harp_f_above_mf(self):
        v = self.zones('harp')
        self.assertEqual(v['KSHarp_F4_mf1'], 0.0)
        self.assertEqual(v['KSHarp_F4_f1'], 1.0)
        self.assertEqual(v['KSHarp_A2_mf1'], 0.0)
        self.assertEqual(v['KSHarp_A2_f1'], 1.0)

    def test_pick_soft_layer_for_low_velocity(self):
        z = sampler._zones('cellos')
        soft, loud = sampler._pick(z, sampler.midi('F2'), 0.3), sampler._pick(z, sampler.midi('F2'), 0.85)
        self.assertTrue(soft['file'].endswith('susvib_F2_v1_1.flac'), soft['file'])
        self.assertTrue(loud['file'].endswith('susvib_F2_v3_1.flac'), loud['file'])


def _write_tone(path, sec=3.0):
    import soundfile as sf
    t = np.arange(N(sec)) / SR
    sf.write(path, np.stack([0.2 * np.sin(2 * np.pi * 440 * t)] * 2, 1), SR, subtype='PCM_24')


@unittest.skipUnless(HAS_FFMPEG, '没有 ffmpeg')
class TestFfmpegMeasurement(unittest.TestCase):
    """R57：ffmpeg 输出按 UTF-8 解码（Windows 英文区域 cp1252 下中文路径不再崩），ffmpeg 失败时报出它自己的错误"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='beiming-ff-')
        self.dir = os.path.join(self.tmp, '桌面', '北冥 引擎', 'out')
        os.makedirs(self.dir)
        self.wav = os.path.join(self.dir, 'mix.wav')
        _write_tone(self.wav)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_chinese_path_under_cp1252_locale(self):
        real = subprocess.run

        def windows_cp1252(args, **kw):
            # 模拟 Windows 英文区域：text=True 而没给 encoding 时，按 cp1252 严格解码（与 subprocess 在那里的行为一致）
            enc, err = kw.pop('encoding', None), kw.pop('errors', None) or 'strict'
            text = kw.pop('text', False) or kw.pop('universal_newlines', False) or enc is not None
            r = real(args, **kw)
            if text:
                enc = enc or 'cp1252'
                r.stdout = r.stdout.decode(enc, err) if r.stdout is not None else None
                r.stderr = r.stderr.decode(enc, err) if r.stderr is not None else None
            return r

        with mock.patch.object(meter.subprocess, 'run', windows_cp1252):
            e = meter.ebur128(self.wav)
        self.assertLess(abs(e['I_LUFS'] - meter.integrated(np.stack([0.2 * np.sin(2 * np.pi * 440 * np.arange(N(3.0)) / SR)] * 2, 1))), 0.15)

    def test_missing_file_reports_ffmpeg_error(self):
        with self.assertRaisesRegex(RuntimeError, 'ffmpeg'):
            meter.ebur128(os.path.join(self.dir, 'nope.wav'))
        with self.assertRaisesRegex(RuntimeError, 'ffmpeg'):
            meter.loudnorm_linear(os.path.join(self.dir, 'nope.wav'))


class TestScopeFont(unittest.TestCase):
    """R58：没有中文字体、Pillow 又早于 10.1（load_default 不收字号）时不崩；BEIMING_CJK_FONT 能指定字体"""

    def test_fallback_without_size_parameter(self):
        def old_load_default():          # Pillow 10.0.x 的签名
            return 'default-font'
        with mock.patch.object(scope, 'FONT_CANDS', []), mock.patch.dict(os.environ, {'BEIMING_CJK_FONT': ''}), \
                mock.patch.object(scope.ImageFont, 'load_default', old_load_default), \
                mock.patch.object(scope, '_WARNED', [1], create=True):
            self.assertEqual(scope.font(24), 'default-font')

    def test_env_font(self):
        cand = next((p for p in ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc',
                                 'C:/Windows/Fonts/msyh.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']
                     if os.path.exists(p)), None)
        if cand is None:
            self.skipTest('本机没有可用的中文字体文件')
        with mock.patch.object(scope, 'FONT_CANDS', []), mock.patch.dict(os.environ, {'BEIMING_CJK_FONT': cand}):
            self.assertEqual(scope.font(24).path, cand)


if __name__ == '__main__':
    unittest.main()
