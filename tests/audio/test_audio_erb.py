# -*- coding: utf-8 -*-
"""engine/audio/erb：96 带 ERB 再合成（CPU 参考实现 core.py 与 GPU 执行器 gpu.py / erb_cuda.cu）。

素材全部是测试里现造的合成声（先静后响的「咔」+ 衰减的谐音 + 噪声），不依赖任何下载文件。
GPU 用例在没有 nvcc 或 GPU 的机器上自动跳过（第一次跑会现场编译内核，约 10 秒，之后命中 .cache/erb/）。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import erb  # noqa: E402
from engine.audio.erb import core, gpu  # noqa: E402
import _audiotest as H  # noqa: E402

SR = core.SR


def click_body(seconds=0.30, stereo=False, seed=1):
    """30 ms 静音 + 1 ms 的「咔」+ 20 ms 衰减噪声 + 45 ms 衰减的两个谐音。stereo=True：右声道更轻、晚 7 个采样、噪声部分独立。"""
    r = np.random.default_rng(seed)
    n = int(seconds * SR)
    on = int(0.030 * SR)
    tt = np.arange(n - on) / SR

    def one(rr):
        x = np.zeros(n)
        x[on:] = (np.exp(-tt / 0.045) * (0.5 * np.sin(2 * np.pi * 820 * tt) + 0.3 * np.sin(2 * np.pi * 1740 * tt + 0.7))
                  + np.exp(-tt / 0.020) * 0.4 * rr.standard_normal(len(tt)) + np.exp(-tt / 0.0012) * 0.9 * rr.standard_normal(len(tt)))
        return x

    left = one(r)
    left *= 0.5 / np.abs(left).max()
    if not stereo:
        return left.astype(np.float32)
    right = 0.7 * np.roll(left, 7) + 0.3 * one(r) * 0.5 / 3.0
    return np.stack([left, right], axis=1).astype(np.float32)


def snr_db(a, b):
    a, b = np.asarray(a, np.float64), np.asarray(b, np.float64)
    return 10 * np.log10((np.sum(a * a) + 1e-30) / (np.sum((a - b) ** 2) + 1e-30))


def band_spectrum_db(y, ref_model):
    """合成结果的逐带平均功率 dB 与模型的差（只看高于峰值 35 dB 内的带），取中位数的绝对值。"""
    m = core.analyze(y)
    a = 10 * np.log10(np.mean(m.env.astype(np.float64) ** 2, axis=1) + 1e-14)
    b = 10 * np.log10(np.mean(ref_model.env.astype(np.float64) ** 2, axis=1) + 1e-14)
    act = b > b.max() - 35.0
    return float(np.median(np.abs(a[act] - b[act])))


class ErbCpuTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.x = click_body()
        cls.model = core.analyze(cls.x)

    def test_model_has_onset_and_no_waveform(self):
        m = self.model
        self.assertIsNotNone(m.onsets, '合成「咔」应当被检出起音')
        self.assertEqual(len(m.onsets), 1)
        self.assertAlmostEqual(m.onsets[0] / SR, 0.030, delta=0.004)
        self.assertEqual(m.env.shape, (core.NB, m.m_active))
        self.assertLess(m.compact_bytes_fp16(), self.x.nbytes * 40)

    def test_render_length_peak_and_quiet_before_onset(self):
        y = core.render(self.model, seed=3, exact=4)
        self.assertEqual(y.shape, self.x.shape)
        self.assertTrue(np.isfinite(y).all())
        self.assertLessEqual(float(np.abs(y).max()), 0.99)
        o = int(self.model.onsets[0])
        self.assertLess(float(np.abs(y[:o - 48]).max()), 0.02 * float(np.abs(y).max()), '起音前 1 ms 之外应当几乎无声')

    def test_same_seed_same_output_different_seed_differs(self):
        a = core.render(self.model, seed=3, exact=3, vary=1.0)
        b = core.render(self.model, seed=3, exact=3, vary=1.0)
        c = core.render(self.model, seed=4, exact=3, vary=1.0)
        self.assertTrue(np.array_equal(a, b))
        self.assertFalse(np.array_equal(a, c))

    def test_vary_changes_detail_but_not_loudness(self):
        outs = [core.render(self.model, seed=s, exact=4, vary=1.0) for s in range(6)]
        rms = np.array([20 * np.log10(np.sqrt(np.mean(y.astype(np.float64) ** 2))) for y in outs])
        self.assertLess(float(rms.max() - rms.min()), 4.0, f'连敲响度漂移 {rms.max() - rms.min():.1f} dB')
        n = min(len(outs[0]), len(outs[1]))  # vary 会抖时长，两下长度不同：截成等长再比
        self.assertLess(abs(float(np.corrcoef(outs[0][:n], outs[1][:n])[0, 1])), 0.5, '不同种子的两下不该是同一份波形')

    def test_spectrum_follows_model(self):
        self.assertLess(band_spectrum_db(core.render(self.model, seed=1, exact=8), self.model), 1.0)

    def test_dur_and_size_change_length(self):
        y = core.render(self.model, seed=1, exact=3, dur=1.5)
        self.assertEqual(len(y), int(round(len(self.x) * 1.5)))
        o = int(self.model.onsets[0])
        self.assertLess(float(np.abs(y[:o - 48]).max()), 0.02 * float(np.abs(y).max()))

    def test_plan_is_deterministic_and_carries_the_random_numbers(self):
        p, q = core.plan(self.model, seed=9, vary=1.0, exact=3), core.plan(self.model, seed=9, vary=1.0, exact=3)
        self.assertTrue(np.array_equal(p.src_pos, q.src_pos) and np.array_equal(p.init_phi, q.init_phi))
        self.assertTrue(np.array_equal(core._execute_numpy(self.model, p), core._execute_numpy(self.model, q)))

    def test_m_floor_only_pads_with_silence(self):
        p = core.plan(self.model, seed=2, exact=3, m_floor=4096)
        self.assertEqual(p.m_base, 4096)
        y = core._execute_numpy(self.model, p)
        self.assertEqual(y.shape, self.x.shape)
        o = int(self.model.onsets[0])
        self.assertLess(float(np.abs(y[:o - 48]).max()), 0.02 * float(np.abs(y).max()))

    def test_render_many_cpu_path_and_device_argument(self):
        ys = erb.render_many([(self.model, dict(seed=1, exact=2)), (self.model, dict(seed=2, exact=2))], device='cpu')
        self.assertTrue(np.array_equal(ys[0], core.render(self.model, seed=1, exact=2)))
        self.assertEqual(len(ys), 2)
        with self.assertRaises(ValueError):
            erb.render_many([], device='tpu')

    def test_takes_args(self):
        ts = core.analyze_takes([click_body(seed=s) for s in (1, 2, 3)])
        m, args = core.takes_args(ts, seed=5, base=1)
        self.assertIs(m, ts.models[1])
        self.assertEqual(args['eq_db'].shape, (2, core.NB))
        self.assertEqual(args['vary'], 1.0)
        y = core.render_takes(ts, seed=5, base=1, exact=3)
        self.assertEqual(y.shape, (ts.models[1].n_orig,), '给了 eq_db 就不抖时长')
        self.assertTrue(np.isfinite(y).all())


@unittest.skipUnless(gpu.available(), '没有 nvcc 或 GPU：跳过 GPU 用例')
class ErbGpuTests(unittest.TestCase):
    """GPU 执行器：与 CPU 参考逐波形对照（host_noise=True，同一份 Plan、同一组随机数）与自身的确定性、批处理一致性。"""

    @classmethod
    def setUpClass(cls):
        cls.mono = core.analyze(click_body())
        cls.stereo = core.analyze(click_body(stereo=True))
        assert cls.mono.onsets is not None and cls.stereo.stereo

    def _parity(self, model, floor_db=90.0, **kw):
        seed = kw.pop('seed', 11)
        p_cpu, p_gpu = core.plan(model, seed=seed, **kw), core.plan(model, seed=seed, **kw)
        y_cpu = core._execute_numpy(model, p_cpu)
        y_gpu = gpu.execute(model, [p_gpu], host_noise=True)[0]
        self.assertEqual(y_cpu.shape, y_gpu.shape)
        self.assertGreater(snr_db(y_cpu, y_gpu), floor_db, f'GPU 与 CPU 不一致：{kw}')

    def test_parity_mono(self):
        self._parity(self.mono, exact=0, impulse_strength=0.0, transients=False)
        self._parity(self.mono, exact=2, transients=False)
        self._parity(self.mono, exact=6)
        self._parity(self.mono, exact=4, vary=1.0)
        self._parity(self.mono, exact=4, dur=1.4, size=0.8, pitch=1.0)
        self._parity(self.mono, exact=3, stereo_out=True, vary=1.0, hard=0.4, bright=1.0)

    def test_parity_stereo(self):
        self._parity(self.stereo, exact=6)
        self._parity(self.stereo, exact=4, vary=1.0, dur=0.8)

    def test_parity_learned_takes(self):
        ts = core.analyze_takes([click_body(seed=s) for s in (1, 2, 3)])
        m, args = core.takes_args(ts, seed=2, base=0)
        self._parity(m, exact=4, **args)

    def test_same_plan_is_bit_identical_and_independent_of_batching(self):
        jobs = [(self.mono, dict(seed=s, exact=3, vary=1.0, dur=1.0 + 0.04 * s)) for s in range(5)]
        a = gpu.render_many(jobs)
        b = gpu.render_many(jobs)
        c = gpu.render_many(jobs, max_chunk=2)
        d = [gpu.render(m, **kw) for m, kw in jobs]
        for i in range(len(jobs)):
            self.assertTrue(np.array_equal(a[i], b[i]), '同一份 Plan 两次结果应逐采样相同')
            self.assertGreater(snr_db(a[i], c[i]), 120.0, '分块不应改变结果')
            self.assertGreater(snr_db(a[i], d[i]), 120.0, '整批与单条不应改变结果')

    def test_device_noise_keeps_the_spectrum_and_the_quiet_before_the_onset(self):
        for model in (self.mono, self.stereo):
            y = gpu.render(model, seed=21, exact=8)
            self.assertLess(band_spectrum_db(y, model), 1.0)
            o = int(model.onsets[0])
            self.assertLess(float(np.abs(y[:o - 48]).max()), 0.02 * float(np.abs(y).max()))
            self.assertLessEqual(float(np.abs(y).max()), 0.99)

    def test_vary_jobs_share_one_m_base(self):
        plans = [gpu.plan(self.mono, seed=s, exact=2, vary=1.0) for s in range(12)]
        self.assertEqual(len({p.m_base for p in plans}), 1, '同一类任务应共用一个 m_base（整批只有一组）')
        self.assertGreater(len({p.out_n for p in plans}), 3, '时长抖动仍在')

    def test_out_of_memory_halves_the_chunk(self):
        jobs = [(self.mono, dict(seed=s, exact=2)) for s in range(7)]
        base = gpu.render_many(jobs)
        calls, real = [], gpu._run_chunk

        def fake(model, plans, host_noise):
            calls.append(len(plans))
            if len(plans) > 2:
                raise gpu.GpuOutOfMemory('模拟显存不够')
            return real(model, plans, host_noise)

        with mock.patch.object(gpu, '_run_chunk', fake):
            ys = gpu.render_many(jobs)
        self.assertEqual(calls[:2], [7, 3])
        self.assertTrue(all(snr_db(a, b) > 120.0 for a, b in zip(base, ys)))

    def test_render_many_mixed_models_keeps_order(self):
        jobs = [(self.mono, dict(seed=1, exact=2)), (self.stereo, dict(seed=2, exact=2)), (self.mono, dict(seed=3, exact=2, dur=1.3))]
        ys = gpu.render_many(jobs)
        self.assertEqual([y.ndim for y in ys], [1, 2, 1])
        self.assertEqual(len(ys[2]), int(round(len(click_body()) * 1.3)))


class ErbCliTests(unittest.TestCase):
    """python -m engine.audio.erb：读 WAV、渲染 N 个新 take 写盘、退出码（走 CPU，没有 GPU 的机器也跑）。"""

    def test_render_takes_to_wav_and_exit_codes(self):
        import soundfile as sf
        from engine.audio.erb import __main__ as cli
        x = click_body()
        with tempfile.TemporaryDirectory() as d:
            src, out = os.path.join(d, 'in.wav'), os.path.join(d, 'takes')
            sf.write(src, x, SR, subtype='PCM_24')
            self.assertEqual(cli.main([src, '--out', out, '--n', '2', '--exact', '2', '--vary', '0', '--device', 'cpu', '--quiet']), 0)
            ys = [sf.read(os.path.join(out, f'take_0{k}.wav'))[0] for k in (1, 2)]
            self.assertEqual([len(y) for y in ys], [len(x)] * 2, '--vary 0 不抖时长')
            self.assertTrue(all(np.isfinite(y).all() and float(np.abs(y).max()) > 0.05 for y in ys))
            self.assertEqual(cli.main([os.path.join(d, 'nope.wav'), '--out', out, '--quiet']), 3, '输入不存在 = 缺依赖')
            self.assertEqual(cli.main([src, '--out', out, '--n', '0', '--quiet']), 2, '用法错误')

    def test_node_cli_wrapper_parity_and_json_envelope(self):
        if not shutil.which('node'):
            self.skipTest('需要 node')
        from engine.audio.erb import __main__ as cli
        import soundfile as sf

        # 1) --help 退出 0 且不起 Python；未知参数退出 2 并返回标准信封
        no_py = dict(BEIMING_PYTHON='/nonexistent-py-binary', BEIMING_PY='/nonexistent-py-binary')
        r_help = H.run(['node', 'tools/audio/erb.mjs', '--help'], **no_py)
        self.assertEqual(r_help.returncode, 0, r_help.stderr)
        self.assertIn('audio:erb', r_help.stdout)
        r_bad = H.run(['node', 'tools/audio/erb.mjs', '--no-such-flag', '--json'], **no_py)
        self.assertEqual(r_bad.returncode, 2, r_bad.stderr)
        env_bad = H.envelope(r_bad)
        self.assertFalse(env_bad['ok'])
        self.assertEqual(env_bad['command'], 'audio:erb')
        self.assertEqual(env_bad['error']['code'], 'usage.unknown-option')

        # 2) Node 声明的选项与 Python argparse 1:1 对齐
        r_opts = H.run(['node', '-e', "import('./tools/audio/erb.mjs').then(m => console.log(JSON.stringify(Object.keys(m.command.options))));"])
        self.assertEqual(r_opts.returncode, 0, r_opts.stderr)
        node_opts = set(json.loads(r_opts.stdout)) - {'help', 'version'}
        py_opts = {s[2:] for act in cli.make_parser()._actions for s in act.option_strings if s.startswith('--') and s != '--help'}
        self.assertEqual(node_opts, py_opts)

        # 3) 端到端 --device cpu --json 输出单个合法信封
        with tempfile.TemporaryDirectory() as d:
            src, out = os.path.join(d, 'in.wav'), os.path.join(d, 'takes')
            sf.write(src, click_body(), SR, subtype='PCM_24')
            r = H.run(['node', 'tools/audio/erb.mjs', src, '--out', out, '--n', '2', '--exact', '2', '--vary', '0',
                       '--device', 'cpu', '--json'], BEIMING_PYTHON=sys.executable)
            self.assertEqual(r.returncode, 0, r.stderr)
            env = H.envelope(r)
            self.assertTrue(env['ok'])
            self.assertEqual(env['command'], 'audio:erb')
            self.assertEqual(env['data']['device'], 'cpu')
            self.assertEqual(len(env['outputs']), 2)


if __name__ == '__main__':
    unittest.main()
