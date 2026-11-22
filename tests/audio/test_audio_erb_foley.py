# -*- coding: utf-8 -*-
"""engine/audio/erb_foley.py：拟音的 ERB 来源（默认关闭、整片一次批量、按内容缓存、种子由 cue/事件/take 决定）。

素材全部是测试里现造的短「咔」（以噪声为主，免得 ERB 保留下来的稳定正弦被误判成拼了原声），不依赖任何下载文件；
全部走 CPU（device='cpu'），没有 GPU 的机器也跑。音频测试域贴着时限，真渲染只在 setUpClass 里做两次，各用例共用。
"""
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import unittest
import warnings
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import erb, erb_foley  # noqa: E402
from engine.audio.erb import core  # noqa: E402

SR = core.SR


def click(seed=1, stereo=True, seconds=0.06):
    """10 ms 静音 + 1 ms 的「咔」+ 衰减噪声，立体声右声道略轻、晚 3 个采样。"""
    r = np.random.default_rng(seed)
    n, on = int(seconds * SR), int(0.010 * SR)
    tt = np.arange(n - on) / SR
    x = np.zeros(n)
    x[on:] = np.exp(-tt / 0.012) * r.standard_normal(n - on) + np.exp(-tt / 0.001) * 3 * r.standard_normal(n - on)
    x *= 0.5 / np.abs(x).max()
    return (np.stack([x, 0.8 * np.roll(x, 3)], 1) if stereo else x).astype(np.float32)


def xcorr_peak(a, b, max_lag=96):
    """±max_lag 个采样（±2 ms）内的最大归一化互相关。拼了原声的输出在这个范围内会接近 1。"""
    a, b = a.mean(1) if a.ndim == 2 else a, b.mean(1) if b.ndim == 2 else b
    n = min(len(a), len(b))
    a, b = a[:n].astype(np.float64), b[:n].astype(np.float64)
    best = 0.0
    for lag in range(-max_lag, max_lag + 1):
        x, y = a[max(0, lag):n + min(0, lag)], b[max(0, -lag):n + min(0, -lag)]
        best = max(best, abs(float(np.dot(x, y))) / (np.linalg.norm(x) * np.linalg.norm(y) + 1e-30))
    return best


SRCS = [click(seed=s) for s in (1, 2)]
MONO = click(seed=4, stereo=False)


def make(cache_dir=None, events=3, **kw):
    t = erb_foley.ErbTakes(device='cpu', exact=1, candidates=2, cache_dir=cache_dir, **kw)
    t.want('q', SRCS, events=events)
    t.want('m', [MONO], events=2)          # 单一来源、单声道
    return t


class SeedAndSwitchTests(unittest.TestCase):
    def test_seed_is_stable_distinct_and_31_bit(self):  # 第三个参数是 take（候选）序号
        self.assertEqual(erb_foley.take_seed('q', 3, 0), erb_foley.take_seed('q', 3, 0))
        seeds = {erb_foley.take_seed(c, e, k) for c in ('q', 'e') for e in range(16) for k in range(3)}
        self.assertEqual(len(seeds), 2 * 16 * 3)
        self.assertTrue(all(0 <= s < 2 ** 31 for s in seeds))
        self.assertNotEqual(erb_foley.take_seed('a', 1, 2), erb_foley.take_seed('a', 2, 1))

    def test_default_off_and_explicit_on(self):
        self.assertFalse(erb_foley.enabled())
        self.assertFalse(erb_foley.enabled({'audio': {'mode': 'script'}}))
        self.assertFalse(erb_foley.enabled({'audio': {'erb': {'enabled': False}}}))
        self.assertTrue(erb_foley.enabled({'audio': {'erb': {'enabled': True}}}))
        self.assertTrue(erb_foley.enabled({}, override=True))
        self.assertFalse(erb_foley.enabled({'audio': {'erb': {'enabled': True}}}, override=False))

    def test_importing_foley_does_not_pull_erb(self):
        import subprocess
        code = "import sys; import engine.audio.foley, engine.audio.editorial; sys.exit(1 if any(m.startswith('engine.audio.erb') for m in sys.modules) else 0)"
        r = subprocess.run([sys.executable, '-c', code], cwd=os.path.join(os.path.dirname(__file__), '..', '..'), capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr.decode('utf-8', 'replace'))


class InputAndMetricTests(unittest.TestCase):
    def test_want_rejects_non_finite_and_bad_shapes(self):
        t = erb_foley.ErbTakes(device='cpu')
        for bad in (np.full(2000, np.nan, np.float32), np.full((2000, 2), np.inf, np.float32), np.zeros((2000, 3), np.float32),
                    np.zeros((2, 2000, 2), np.float32), np.zeros(4, np.float32)):
            with self.assertRaises(ValueError, msg=str(bad.shape)):
                t.want('x', [SRCS[0], bad], events=2)
        self.assertEqual(t._wants, {}, '被拒的 cue 不应登记')

    def test_fidelity_is_zero_against_itself_and_ignores_zero_padding(self):
        x = SRCS[0]
        for other in (x, np.pad(x, ((0, len(x)), (0, 0))), np.pad(x, ((len(x) // 3, 0), (0, 0)))):
            for k, v in erb_foley.fidelity(other, x).items():
                self.assertLess(abs(v), 0.02, (other.shape, k, v))

    def test_source_shape_is_part_of_the_cache_key(self):
        flat = SRCS[0].reshape(-1)
        self.assertNotEqual(erb_foley._wave_sha(flat), erb_foley._wave_sha(flat.reshape(-1, 2)))

    def test_changed_source_or_param_changes_the_key(self):
        t, sha = make(), erb_foley._wave_sha(SRCS[0])
        k0 = t._key(sha, 'q', 0, 'cpu')[0]
        self.assertNotEqual(k0, erb_foley.ErbTakes(device='cpu', exact=2, candidates=2)._key(sha, 'q', 0, 'cpu')[0])
        self.assertNotEqual(k0, t._key(erb_foley._wave_sha(SRCS[1]), 'q', 0, 'cpu')[0])
        self.assertNotEqual(k0, t._key(erb_foley._wave_sha(SRCS[0]), 'q', 0, 'gpu')[0])
        self.assertNotEqual(k0, t._key(erb_foley._wave_sha(SRCS[0]), 'q', 1, 'cpu')[0])

    def test_non_finite_output_is_neither_saved_nor_returned(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        t = erb_foley.ErbTakes(device='cpu', exact=1, candidates=2, cache_dir=d).want('q', [SRCS[0]], events=1)
        with mock.patch.object(erb_foley.erb, 'render_many', side_effect=lambda jobs, device: [np.full_like(SRCS[0], np.nan)] * len(jobs)):
            with self.assertRaisesRegex(ValueError, 'NaN'):
                t.render()
        self.assertEqual(os.listdir(d), [])

    def test_concurrent_saves_of_one_key_do_not_clash(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        t = erb_foley.ErbTakes(device='cpu', cache_dir=d)
        errors = []

        def save():
            try:
                for _ in range(10):
                    t._save('k', {'x': 1}, SRCS[0], {'gate': 'pass'})
            except Exception as e:   # noqa: BLE001
                errors.append(e)
        ths = [threading.Thread(target=save) for _ in range(4)]
        [th.start() for th in ths]
        [th.join() for th in ths]
        self.assertEqual(errors, [])
        self.assertEqual(sorted(os.listdir(d)), ['k.json', 'k.npz'], '不留临时文件')
        self.assertTrue(np.array_equal(t._load('k')[0], SRCS[0]))

    def test_bad_cache_files_are_misses(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        t = erb_foley.ErbTakes(device='cpu', cache_dir=d)
        p = os.path.join(d, 'k.npz')
        t._save('k', {}, SRCS[0], {'gate': 'pass'})
        good = pathlib.Path(p).read_bytes()
        for name, write in (('0 字节', lambda: pathlib.Path(p).write_bytes(b'')),
                            ('截断的 zip', lambda: pathlib.Path(p).write_bytes(good[:len(good) // 2])),
                            ('meta=1', lambda: np.savez(p, wave=SRCS[0], sha256=erb_foley._wave_sha(SRCS[0]), meta='1')),
                            ('meta=[]', lambda: np.savez(p, wave=SRCS[0], sha256=erb_foley._wave_sha(SRCS[0]), meta='[]')),
                            ('sha 不符', lambda: np.savez(p, wave=SRCS[0], sha256='0', meta='{"gate": "pass"}'))):
            write()
            self.assertIsNone(t._load('k'), name)


class RenderTests(unittest.TestCase):
    """整片两次真渲染（空缓存、无缓存），再用缓存跑一次。"""

    @classmethod
    def setUpClass(cls):
        cls.cache = tempfile.mkdtemp()
        cls.a = make(cls.cache)
        real = erb.render_many
        with mock.patch.object(erb_foley.erb, 'render_many', side_effect=real) as m:
            cls.ra = cls.a.render()
        cls.calls, cls.njobs = m.call_count, len(m.call_args[0][0])
        cls.rb = make().render()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache)

    def test_one_batch_call_for_the_whole_film(self):
        self.assertEqual(self.calls, 1, '整片的 ERB 任务必须合成一次 render_many')
        self.assertEqual(self.njobs, (3 + 2) * 2, '每个事件 2 个候选，全在这一次调用里')
        self.assertEqual(self.a.report['jobs'], 5)
        self.assertEqual([len(self.ra['q']), len(self.ra['m'])], [3, 2])

    def test_bit_identical_across_runs_and_takes_all_differ(self):
        for cue in self.ra:
            for x, y in zip(self.ra[cue], self.rb[cue]):
                self.assertTrue(np.array_equal(x[0], y[0]), f'{cue} 两遍渲染应逐比特相同')
        waves = [w[0] for cue in self.ra for w in self.ra[cue]]
        for i in range(len(waves)):
            for j in range(i + 1, len(waves)):
                a, b = waves[i], waves[j]
                n = min(len(a), len(b))
                self.assertFalse(a.shape == b.shape and np.array_equal(a, b), f'take {i} 与 {j} 完全相同')
                if a.ndim == b.ndim == 2:
                    self.assertLess(abs(float(np.corrcoef(a[:n, 0], b[:n, 0])[0, 1])), 0.9)

    def test_output_shape_matches_source_channels(self):
        self.assertEqual(self.ra['m'][0][0].ndim, 1)
        self.assertEqual(self.ra['q'][0][0].ndim, 2)
        self.assertTrue(all(np.isfinite(w[0]).all() for c in self.ra.values() for w in c))

    def test_take_does_not_contain_the_source_waveform(self):
        worst = max(xcorr_peak(w, s) for w, _ in self.ra['q'] for s in SRCS)
        self.assertLess(worst, 0.35, '输出与来源在 ±2 ms 内的波形相关过高，像是拼了原声')
        spliced = self.ra['q'][0][0].copy()          # 对照：把来源的一段直接拼进去，同一把尺必须量得出来
        m = min(len(spliced), len(SRCS[0]))
        spliced[:m] = 0.7 * spliced[:m] + 0.7 * SRCS[0][:m]
        self.assertGreater(xcorr_peak(spliced, SRCS[0]), 0.6)

    def test_gate_meta_matches_fidelity_and_seed(self):
        for cue, srcs in (('q', SRCS), ('m', [MONO])):
            for e, (w, meta) in enumerate(self.ra[cue]):
                self.assertEqual(meta['seed'], erb_foley.take_seed(cue, e, meta['attempt']))
                fid = erb_foley.fidelity(w, srcs[e % len(srcs)])
                if meta['gate'] == 'pass':
                    self.assertEqual(meta['judge'], 'pass')
                    self.assertLess(max(abs(v) for v in fid.values()), 1.5, (cue, e, fid))
        self.assertEqual(self.a.report['fallback'], sum(m['gate'] == 'fallback' for c in self.ra.values() for _, m in c))
        # 夹具在 CPU 上是确定的：钉住哪几条过闸，_gate 退化成永远不过（或永远过）时这里会失败
        gates = {c: [m['gate'] for _, m in v] for c, v in self.ra.items()}
        self.assertEqual(gates, {'q': ['fallback', 'pass', 'fallback'], 'm': ['pass', 'pass']})
        self.assertEqual(self.a.report['fallback'], 2)

    def test_gate_skips_failing_candidates_and_takes_the_first_pass(self):
        # 不真渲染：render_many 与 _gate 都换成假的，候选 0 不过、候选 1 过 → 必须选 attempt 1；全不过 → 取偏差最小的 fallback
        cands = [np.full_like(SRCS[0], 0.01 * (i + 1)) for i in range(3)]
        for seq, want in (([(False, 3.0), (True, 0.1), (True, 0.2)], (1, 'pass')),
                          ([(False, 3.0), (False, 0.5), (False, 2.0)], (1, 'fallback')),
                          ([(True, 0.3), (True, 0.1), (True, 0.1)], (0, 'pass'))):
            it = iter(seq)
            calls = []

            def gate(y, src):
                ok, d = next(it)
                calls.append(float(y.flat[0]))
                return ok, {'bw95_db': d, 'hf12_db': 0.0, 'hf12_energy_db': 0.0}, 'pass' if ok else 'suspect'
            t = erb_foley.ErbTakes(device='cpu', exact=1, candidates=3).want('q', [SRCS[0]], events=1)
            with mock.patch.object(erb_foley.erb, 'render_many', side_effect=lambda jobs, device: cands[:len(jobs)]), \
                    mock.patch.object(t, '_gate', side_effect=gate):
                w, meta = t.render()['q'][0]
            self.assertEqual((meta['attempt'], meta['gate']), want, seq)
            self.assertTrue(np.array_equal(w, cands[want[0]]))
            self.assertEqual(meta['seed'], erb_foley.take_seed('q', 0, want[0]))
            self.assertEqual(len(calls), want[0] + 1 if want[1] == 'pass' else 3, '过了就停，不再评后面的候选')

    def test_cache_hits_match_and_keep_meta_and_new_events_render_alone(self):
        b = make(self.cache, events=5)                     # 多了两个事件：已有事件命中缓存，只渲新的
        rb = b.render()
        self.assertEqual((b.report['cached'], b.report['rendered']), (5, 2))
        self.assertEqual(b.report['fallback'], sum(m['gate'] == 'fallback' for c in rb.values() for _, m in c))
        for cue in self.ra:
            for (x, mx), (y, my) in zip(self.ra[cue], rb[cue]):
                self.assertTrue(np.array_equal(x, y))
                self.assertEqual((mx['attempt'], mx['gate']), (my['attempt'], my['gate']))
                self.assertTrue(my['cached'])


class FallbackAndDeviceTests(unittest.TestCase):
    """一个事件、阈值不可能达到：必走 fallback；再用它的 CPU 缓存核对设备与坏缓存的处理。"""

    @classmethod
    def setUpClass(cls):
        cls.cache = tempfile.mkdtemp()
        cls.t = cls.mk('cpu')
        cls.r = cls.t.render()['q']

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache)

    @classmethod
    def mk(cls, device, cache=True):
        return erb_foley.ErbTakes(device=device, exact=1, candidates=2, tol_db=1e-6,
                                  cache_dir=cls.cache if cache else None).want('q', [SRCS[0]], events=1)

    def test_fallback_is_loud_and_counted_from_cache_too(self):
        self.assertEqual(self.r[0][1]['gate'], 'fallback')
        self.assertEqual(self.t.report['fallback'], 1)
        again = self.mk('cpu')
        again.render()
        self.assertEqual((again.report['cached'], again.report['fallback']), (1, 1))

    def test_forced_gpu_never_uses_cpu_cache(self):
        with mock.patch.object(erb_foley.erb.gpu, 'available', return_value=False):
            with self.assertRaises(erb_foley.erb.gpu.GpuUnavailable):
                self.mk('gpu').render()

    def test_auto_reuses_the_cpu_cache_after_an_oom_fallback(self):
        with mock.patch.object(erb_foley.erb.gpu, 'available', return_value=True), \
                mock.patch.object(erb_foley.erb, 'render_many', side_effect=AssertionError('应当命中 CPU 缓存')):
            t = self.mk('auto')
            out = t.render()
        self.assertEqual(t.report['cached'], 1)
        self.assertEqual(out['q'][0][1]['device'], 'cpu')
        self.assertEqual((t.report['device'], t.report['devices']), ('cpu', {'cpu': 1}), '全部命中 CPU 缓存时报 cpu，不报 gpu')

    def test_mixed_devices_are_reported_as_mixed(self):
        # 事件 0 命中上次的 CPU 缓存，事件 1 这次在「GPU」上渲（假的 render_many）
        with mock.patch.object(erb_foley.erb.gpu, 'available', return_value=True), \
                mock.patch.object(erb_foley.erb, 'render_many', side_effect=lambda jobs, device: [self.r[0][0]] * len(jobs)):
            t = erb_foley.ErbTakes(device='auto', exact=1, candidates=2, tol_db=1e-6, cache_dir=self.cache).want('q', [SRCS[0]], events=2)
            out = t.render()['q']
        self.assertEqual([m['device'] for _, m in out], ['cpu', 'gpu'])
        self.assertEqual((t.report['device'], t.report['devices']), ('mixed', {'cpu': 1, 'gpu': 1}))

    def test_oom_warning_reaches_the_caller(self):
        def fake(jobs, device):
            warnings.warn('显存不够放下其中一条，这一批退回 CPU', RuntimeWarning)
            return [self.r[0][0]] * len(jobs)
        with mock.patch.object(erb_foley.erb.gpu, 'available', return_value=True), \
                mock.patch.object(erb_foley.erb, 'render_many', side_effect=fake):
            t = self.mk('auto', cache=False)
            with self.assertWarnsRegex(RuntimeWarning, '退回 CPU'):
                out = t.render()
        self.assertEqual((t.report['device'], out['q'][0][1]['device']), ('cpu', 'cpu'))

    def test_corrupt_cache_file_is_rerendered(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d)
        for f in os.listdir(self.cache):
            shutil.copy(os.path.join(self.cache, f), d)
        for f in os.listdir(d):
            if f.endswith('.npz'):
                pathlib.Path(d, f).write_bytes(b'')
        t = erb_foley.ErbTakes(device='cpu', exact=1, candidates=2, tol_db=1e-6, cache_dir=d).want('q', [SRCS[0]], events=1)
        out = t.render()['q']
        self.assertEqual((t.report['cached'], t.report['rendered']), (0, 1))
        self.assertTrue(np.array_equal(out[0][0], self.r[0][0]))


class DeckPolicyTests(unittest.TestCase):
    def test_erb_policy_plays_each_take_once_in_order_without_pitch_or_eq(self):
        from engine.audio import editorial, foley
        takes = [click(seed=s) for s in (1, 2, 3)]
        series = editorial.schedule_action_series([0.0, 1.0, 2.0], forces=[0.7, 0.7, 0.7], takes=takes, policy='erb', min_tail_s=5.0)
        for i, item in enumerate(series):
            self.assertEqual(item['meta']['policy'], 'erb')
            self.assertEqual(item['meta']['takeIndex'], i)
            self.assertEqual(item['meta']['semitones'], 0.0)
            ref = takes[i] * (0.45 + 0.65 * 0.7 ** 0.9)          # 只按力度定增益；schedule_action_series 只动尾巴，前半段原样
            h = len(ref) // 2
            self.assertTrue(np.allclose(item['wave'][:h], ref[:h], atol=1e-4))
        with self.assertRaises(ValueError):
            foley.ActionVariationDeck(takes, policy='nope')

    def test_existing_policies_unchanged(self):
        from engine.audio import foley
        t = click(seed=1)
        d1 = foley.ActionVariationDeck([t], seed=9)
        d2 = foley.ActionVariationDeck([t], seed=9, policy='anti_fatigue')
        for f in (0.5, 0.9):
            a, b = d1.trigger(f), d2.trigger(f)
            self.assertTrue(np.array_equal(a[0], b[0]) and a[2] == b[2])


if __name__ == '__main__':
    unittest.main()
