# -*- coding: utf-8 -*-
"""engine/audio/erb_foley.py：拟音的 ERB 来源（默认关闭、整片一次批量、按内容缓存、种子由 cue/事件/take 决定）。

素材全部是测试里现造的合成「咔」，不依赖任何下载文件；全部走 CPU（device='cpu'），没有 GPU 的机器也跑。
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import erb, erb_foley  # noqa: E402
from engine.audio.erb import core  # noqa: E402

SR = core.SR


def click(seconds=0.12, seed=1, stereo=True):
    """15 ms 静音 + 1 ms 的「咔」+ 衰减噪声 + 衰减谐音，立体声右声道略轻。"""
    r = np.random.default_rng(seed)
    n, on = int(seconds * SR), int(0.015 * SR)
    tt = np.arange(n - on) / SR

    def one():
        x = np.zeros(n)
        x[on:] = (np.exp(-tt / 0.03) * 0.4 * np.sin(2 * np.pi * (900 + 80 * seed) * tt)
                  + np.exp(-tt / 0.015) * 0.4 * r.standard_normal(len(tt)) + np.exp(-tt / 0.001) * 0.9 * r.standard_normal(len(tt)))
        return x * 0.5 / np.abs(x).max()
    left = one()
    if not stereo:
        return left.astype(np.float32)
    return np.stack([left, 0.8 * one()], axis=1).astype(np.float32)


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


def make(cache_dir=None):
    srcs = [click(seed=s) for s in (1, 2, 3)]
    t = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3, cache_dir=cache_dir)
    t.want('snip_q', srcs, events=4)
    t.want('snip_e', [click(seed=4)], events=3)     # 单一来源：vary 抖动
    return t, srcs


class SeedTests(unittest.TestCase):
    def test_seed_is_stable_distinct_and_31_bit(self):  # 第三个参数是 take（候选）序号
        a = erb_foley.take_seed('snip_q', 3, 0)
        self.assertEqual(a, erb_foley.take_seed('snip_q', 3, 0))
        seeds = {erb_foley.take_seed(c, e, k) for c in ('snip_q', 'snip_e') for e in range(16) for k in range(3)}
        self.assertEqual(len(seeds), 2 * 16 * 3)
        self.assertTrue(all(0 <= s < 2 ** 31 for s in seeds))
        self.assertNotEqual(erb_foley.take_seed('a', 1, 2), erb_foley.take_seed('a', 2, 1))


class SwitchTests(unittest.TestCase):
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


class RenderTests(unittest.TestCase):
    def test_one_batch_call_for_the_whole_film(self):
        t, _ = make()
        real = erb.render_many
        with mock.patch.object(erb_foley.erb, 'render_many', side_effect=real) as m:
            out = t.render()
        self.assertEqual(m.call_count, 1, '整片的 ERB 任务必须合成一次 render_many')
        self.assertEqual(len(m.call_args[0][0]), (4 + 3) * 3, '每个事件 3 个候选，全在这一次调用里')
        self.assertEqual(t.report['jobs'], 7)
        self.assertEqual(len(out['snip_q']), 4)
        self.assertEqual(len(out['snip_e']), 3)

    def test_bit_identical_across_runs_and_takes_all_differ(self):
        a, _ = make()
        b, _ = make()
        ra, rb = a.render(), b.render()
        for cue in ra:
            for x, y in zip(ra[cue], rb[cue]):
                self.assertTrue(np.array_equal(x[0], y[0]), f'{cue} 两遍渲染应逐比特相同')
        waves = [w[0] for cue in ra for w in ra[cue]]
        for i in range(len(waves)):
            for j in range(i + 1, len(waves)):
                n = min(len(waves[i]), len(waves[j]))
                self.assertFalse(np.array_equal(waves[i][:n], waves[j][:n]), f'take {i} 与 {j} 完全相同')
        for cue in ra:
            ws = [w[0] for w in ra[cue]]
            for i in range(len(ws)):
                for j in range(i + 1, len(ws)):
                    n = min(len(ws[i]), len(ws[j]))
                    self.assertLess(abs(float(np.corrcoef(ws[i][:n, 0], ws[j][:n, 0])[0, 1])), 0.9)

    def test_take_does_not_contain_the_source_waveform(self):
        # 来源用噪声为主的「咔」（没有会被 ERB 保留频率的稳定正弦，免得把「同频」误判成「拼了原声」）
        r = np.random.default_rng(7)
        n, on = int(0.12 * SR), int(0.015 * SR)
        tt = np.arange(n - on) / SR
        srcs = []
        for _ in range(3):
            x = np.zeros(n)
            x[on:] = np.exp(-tt / 0.02) * r.standard_normal(n - on) + np.exp(-tt / 0.001) * 3 * r.standard_normal(n - on)
            x *= 0.5 / np.abs(x).max()
            srcs.append(np.stack([x, 0.8 * np.roll(x, 3)], 1).astype(np.float32))
        t = erb_foley.ErbTakes(device='cpu', exact=2)
        t.want('n', srcs, events=3)
        out = t.render()['n']
        worst = max(xcorr_peak(w[0], s) for w in out for s in srcs)
        self.assertLess(worst, 0.35, '输出与来源在 ±2 ms 内的波形相关过高，像是拼了原声')
        # 对照：把来源的一段直接拼进去，同一把尺必须量得出来
        spliced = out[0][0].copy()
        m = min(len(spliced), len(srcs[0]))
        spliced[:m] = 0.7 * spliced[:m] + 0.7 * srcs[0][:m]
        self.assertGreater(xcorr_peak(spliced, srcs[0]), 0.6)

    def test_changing_event_index_changes_the_take_but_not_other_events(self):
        a, _ = make()
        ra = a.render()
        b = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3)
        b.want('snip_q', [click(seed=s) for s in (1, 2, 3)], events=6)   # 多了两个事件
        rb = b.render()
        for k in range(4):
            self.assertTrue(np.array_equal(ra['snip_q'][k][0], rb['snip_q'][k][0]), '已有事件不能因为事件数变化而变')

    def test_output_shape_matches_source_channels(self):
        t = erb_foley.ErbTakes(device='cpu', exact=2)
        t.want('mono', [click(seed=1, stereo=False)], events=2)
        t.want('st', [click(seed=1), click(seed=2)], events=2)
        out = t.render()
        self.assertEqual(out['mono'][0][0].ndim, 1)
        self.assertEqual(out['st'][0][0].ndim, 2)
        self.assertTrue(all(np.isfinite(w[0]).all() for c in out.values() for w in c))


class CacheTests(unittest.TestCase):
    def test_second_run_hits_cache_and_matches(self):
        with tempfile.TemporaryDirectory() as d:
            a, _ = make(d)
            ra = a.render()
            self.assertEqual(a.report['rendered'], 7)
            b, _ = make(d)
            with mock.patch.object(erb_foley.erb, 'render_many', side_effect=AssertionError('缓存命中时不该再渲染')):
                rb = b.render()
            self.assertEqual(b.report['cached'], 7)
            self.assertEqual(b.report['rendered'], 0)
            for cue in ra:
                for x, y in zip(ra[cue], rb[cue]):
                    self.assertTrue(np.array_equal(x[0], y[0]))

    def test_changed_source_or_param_misses(self):
        with tempfile.TemporaryDirectory() as d:
            a, _ = make(d)
            a.render()
            c = erb_foley.ErbTakes(device='cpu', exact=3, candidates=3, cache_dir=d)      # exact 不同
            c.want('snip_q', [click(seed=s) for s in (1, 2, 3)], events=4)
            c.render()
            self.assertEqual(c.report['cached'], 0)
            e = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3, cache_dir=d)
            e.want('snip_q', [click(seed=s) for s in (7, 8, 9)], events=4)  # 来源全换
            e.render()
            self.assertEqual(e.report['cached'], 0)


class FidelityGateTests(unittest.TestCase):
    def test_fidelity_metric_is_zero_against_itself(self):
        x = click(seed=2)
        f = erb_foley.fidelity(x, x)
        self.assertAlmostEqual(f['bw95_db'], 0.0, places=6)
        self.assertAlmostEqual(f['hf12_db'], 0.0, places=6)
        self.assertAlmostEqual(f['hf12_energy_db'], 0.0, places=6)

    def test_chosen_takes_meet_tolerance_and_say_which_attempt(self):
        t = erb_foley.ErbTakes(device='cpu', exact=2, candidates=4, tol_db=1.5)
        srcs = [click(seed=s) for s in (1, 2, 3)]
        t.want('c', srcs, events=3)
        out = t.render()['c']
        self.assertEqual(t.report['jobs'], 3)
        self.assertEqual(t.report['candidates'], 12)
        for e, (w, meta) in enumerate(out):
            self.assertIn(meta['attempt'], range(4))
            self.assertEqual(meta['gate'], 'pass')
            fid = erb_foley.fidelity(w, srcs[e % 3])
            for k in ('bw95_db', 'hf12_db', 'hf12_energy_db'):
                self.assertLess(abs(fid[k]), 1.5, (e, meta['attempt'], fid))
            self.assertEqual(meta['seed'], erb_foley.take_seed('c', e, meta['attempt']))

    def test_impossible_tolerance_falls_back_loudly_to_the_closest_candidate(self):
        t = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3, tol_db=1e-6)
        t.want('c', [click(seed=1)], events=2)
        out = t.render()['c']
        for w, meta in out:
            self.assertEqual(meta['gate'], 'fallback')
            self.assertTrue(np.isfinite(w).all())
        self.assertEqual(t.report['fallback'], 2)

    def test_chosen_take_is_cached_with_its_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            a = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3, cache_dir=d)
            a.want('c', [click(seed=1), click(seed=2)], events=3)
            ra = a.render()['c']
            b = erb_foley.ErbTakes(device='cpu', exact=2, candidates=3, cache_dir=d)
            b.want('c', [click(seed=1), click(seed=2)], events=3)
            with mock.patch.object(erb_foley.erb, 'render_many', side_effect=AssertionError('命中缓存不该再渲')):
                rb = b.render()['c']
            for (x, mx), (y, my) in zip(ra, rb):
                self.assertTrue(np.array_equal(x, y))
                self.assertEqual(mx['attempt'], my['attempt'])
                self.assertTrue(my['cached'])


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
