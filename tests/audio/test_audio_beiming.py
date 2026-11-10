# -*- coding: utf-8 -*-
"""《北冥》声音构建的门禁与金标准（npm run audio:build → python audio/build.py）。

在只含声音链路的临时树里跑（tests/audio/_audiotest.py 的 sound_tree），不碰仓库的 out/ 与 audio/check/：
  · 默认构建（配乐读定稿缓存）通过门禁，audio/check/qa.json 是附录 C8 的结构；--json 时 stdout 只有一个信封；
  · 混音与分轨与本平台的金标准一致（tests/audio/golden/<平台>.json，判定见 beiming_golden.py；只跑 mix.py，不需要 ffmpeg；本平台没有记录时跳过）；
  · 混音整体 +6 dB 后 audio/check.py --strict 退出 4（满幅、响度、真峰值三项不通过）；
  · 把 audio/cues.json 的混音目标抬高 6 dB 后整个 build 退出 4；
  · 配乐缓存：乐谱 audio/score.py 改过就退出 4（不静默沿用旧配乐），--accept-stale-score 明确接受时通过并记进 render.json；
    缓存文件被换掉时 --accept-stale-score 也不放行；
  · sh audio/build.sh 与 node tools/audio/build.mjs 两个入口：--help 退出 0，未知参数退出 2；
  · 设了 BEIMING_SAMPLES（固定版本的采样库）时：--score 重渲可复现，重渲当次与之后读缓存的混音逐字节相同。
门禁需要 ffmpeg（环境变量 FFMPEG / FFPROBE 可指完整路径）；没有时门禁的用例跳过，金标准与配乐缓存的用例照常跑。
每次构建约 5–10 秒（numba 缓存冷时多十几秒）。
"""
import json
import os
import shutil
import unittest

import numpy as np
import soundfile as sf

import _audiotest as H
import beiming_golden as G

FF = H.which_ffmpeg()
NODE = shutil.which('node')
SH = shutil.which('sh')


def edit_json(path, fn):
    d = H.read_json(path)
    fn(d)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)


@unittest.skipUnless(FF, '需要 ffmpeg / ffprobe（或设 FFMPEG、FFPROBE）')
class BeimingGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.sound_tree(H.tmpdir('beiming-gate'))
        cls.r = H.run(['python', 'audio/build.py', '--json'], cwd=cls.td)
        if cls.r.returncode not in (0, 4):
            raise RuntimeError(f'默认构建没跑完（退出码 {cls.r.returncode}）：{cls.r.stderr[-1500:]}')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_default_build_passes_gate(self):
        self.assertEqual(self.r.returncode, 0, self.r.stderr[-1500:])
        env = H.envelope(self.r)
        self.assertTrue(env['ok'])
        self.assertEqual(env['command'], 'audio:build')
        kinds = {o['kind']: o['path'] for o in env['outputs']}
        self.assertEqual(kinds.get('audio'), 'out/mix.wav')
        self.assertEqual(kinds.get('qa-report'), 'audio/check/qa.json')
        rep = H.read_json(os.path.join(self.td, 'audio', 'check', 'qa.json'))
        self.assertTrue(rep['ok'])
        self.assertEqual(rep['schemaVersion'], 1)
        self.assertEqual(rep['profile']['id'], 'beiming-1040p24')
        ids = {c['id'] for c in rep['checks']}
        self.assertTrue({'audio.loudness', 'audio.truepeak', 'audio.cuts', 'audio.deliverable', 'audio.ui-snr'} <= ids, ids)
        for c in rep['checks']:
            self.assertIn(c['status'], ('pass', 'warn', 'fail', 'waived'))
            for k in ('value', 'expected', 'evidence'):
                self.assertIn(k, c)

    def test_plus_6db_mix_fails_strict_check(self):
        wav = os.path.join(self.td, 'out', 'mix.wav')
        keep = wav + '.keep'
        shutil.copy(wav, keep)
        try:
            x, sr = sf.read(wav, dtype='float64', always_2d=True)
            sf.write(wav, x * 10 ** (6 / 20), sr, subtype='FLOAT')
            r = H.run(['python', 'audio/check.py', '--strict', '--json'], cwd=self.td)
            self.assertEqual(r.returncode, 4, r.stderr[-1500:])
            env = H.envelope(r)
            hard = set(env['data']['summary']['hardFailures'])
            self.assertTrue({'audio.overload', 'audio.loudness', 'audio.truepeak'} <= hard, hard)
        finally:
            os.replace(keep, wav)


class BeimingGolden(unittest.TestCase):
    """混音金标准只要混音（audio/mix.py），不需要 ffmpeg：CI 的 unit job 也能比"""

    def test_golden(self):
        gold = G.load()
        if gold is None:
            self.skipTest(f'没有 {G.platform_key()} 的混音金标准：在锁定环境里跑 python tests/audio/beiming_golden.py record')
        td = H.sound_tree(H.tmpdir('beiming-golden'))
        try:
            r = H.run(['python', 'audio/mix.py'], cwd=td)
            self.assertEqual(r.returncode, 0, r.stderr[-1500:])
            ok, mode, lines = G.compare(G.measure(td), gold)
            self.assertTrue(ok, f'《北冥》混音与金标准不一致（{mode}）：\n' + '\n'.join(lines))
        finally:
            shutil.rmtree(td, ignore_errors=True)


@unittest.skipUnless(FF, '需要 ffmpeg / ffprobe（或设 FFMPEG、FFPROBE）')
class BeimingGateTargetRaised(unittest.TestCase):
    def test_build_exits_4_when_mix_target_raised_6db(self):
        td = H.sound_tree(H.tmpdir('beiming-plus6'))
        try:
            edit_json(os.path.join(td, 'audio', 'cues.json'), lambda d: d['target'].__setitem__('integrated_lufs', d['target']['integrated_lufs'] + 6))
            r = H.run(['python', 'audio/build.py', '--json'], cwd=td)
            self.assertEqual(r.returncode, 4, r.stderr[-1500:])
            env = H.envelope(r)
            self.assertEqual(env['error']['code'], 'contract.audio-gate')
            self.assertTrue(env['data']['gate']['hardFailures'])
        finally:
            shutil.rmtree(td, ignore_errors=True)


class ScoreCache(unittest.TestCase):
    """配乐缓存的输入键（engine/audio/scorecache.py、audio/score_cache.lock.json）：mix.py 一步就停，不需要 ffmpeg"""

    def setUp(self):
        self.td = H.sound_tree(H.tmpdir('beiming-score'))

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def mix(self, *flags):
        return H.run(['python', 'audio/mix.py', *flags], cwd=self.td)

    def test_score_source_changed_refuses_stale_cache(self):
        with open(os.path.join(self.td, 'audio', 'score.py'), 'a', encoding='utf-8') as f:
            f.write('\n# 作者改了乐谱\n')
        r = self.mix()
        self.assertEqual(r.returncode, 4, r.stderr[-800:])
        self.assertIn('audio/score.py 改过了', r.stderr)
        self.assertIn('--score', r.stderr)
        r = H.run(['python', 'audio/build.py', '--json'], cwd=self.td)
        self.assertEqual(r.returncode, 4)
        self.assertEqual(H.envelope(r)['error']['code'], 'contract.score-cache')
        r = self.mix('--accept-stale-score')
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        rj = H.read_json(os.path.join(self.td, 'audio', 'check', 'render.json'))
        self.assertEqual(rj['score_cache']['status'], 'stale-accepted')
        self.assertIn('audio/score.py', rj['score_cache']['changed'])

    def test_swapped_cache_is_refused_even_when_accepting_stale(self):
        npz = os.path.join(self.td, 'audio', 'score_cache.npz')
        c = np.load(npz)
        mus = c['mus'].copy()
        mus[1000:1010] += 0.01
        np.savez_compressed(npz, mus=mus, harmony=c['harmony'], used=c['used'])
        r = self.mix('--accept-stale-score')
        self.assertEqual(r.returncode, 4, r.stderr[-800:])
        self.assertIn('不是 lock 登记的那一份', r.stderr)

    def test_missing_lock_is_refused(self):
        os.remove(os.path.join(self.td, 'audio', 'score_cache.lock.json'))
        r = self.mix()
        self.assertEqual(r.returncode, 4)
        self.assertIn('没有输入键', r.stderr)

    def test_frozen_cache_ignores_engine_code_changes(self):
        """定稿配乐只登记乐谱源码：改引擎的采样器不影响读缓存（它本来就不能由当前代码逐样本重渲，见 lock 的 note）"""
        with open(os.path.join(self.td, 'engine', 'audio', 'sampler.py'), 'a', encoding='utf-8') as f:
            f.write('\n# 引擎改动\n')
        r = self.mix()
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertEqual(H.read_json(os.path.join(self.td, 'audio', 'check', 'render.json'))['score_cache']['status'], 'frozen')


@unittest.skipUnless(os.environ.get('BEIMING_SAMPLES'), '要配乐采样库：node tools/audio/fetch-samples.mjs 后设 BEIMING_SAMPLES（约 451 MB）')
class ScoreRerender(unittest.TestCase):
    """用固定版本的采样库 --score 重渲：库与清单逐个核对通过；两次重渲逐样本相同；重渲当次与之后读缓存的混音逐字节相同"""

    def test_score_rerender_is_reproducible(self):
        td = H.sound_tree(H.tmpdir('beiming-score-rerender'))
        try:
            mix = os.path.join(td, 'out', 'mix.wav')
            r = H.run(['python', 'audio/mix.py', '--score'], cwd=td)
            self.assertEqual(r.returncode, 0, r.stderr[-1500:])
            rj = H.read_json(os.path.join(td, 'audio', 'check', 'render.json'))['score_cache']
            self.assertEqual((rj['status'], rj['library_ok']), ('rendered', True), rj)
            lock = H.read_json(os.path.join(td, 'audio', 'score_cache.lock.json'))
            self.assertFalse(lock['frozen'])
            self.assertTrue(lock['inputs']['samplesLibrary'])
            first = G._sha(mix)
            mus1 = np.load(os.path.join(td, 'audio', 'score_cache.npz'))['mus']
            r = H.run(['python', 'audio/mix.py'], cwd=td)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            self.assertEqual(H.read_json(os.path.join(td, 'audio', 'check', 'render.json'))['score_cache']['status'], 'match')
            self.assertEqual(G._sha(mix), first, '重渲当次与读缓存的混音要逐字节相同')
            r = H.run(['python', 'audio/mix.py', '--score'], cwd=td)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            self.assertTrue(np.array_equal(np.load(os.path.join(td, 'audio', 'score_cache.npz'))['mus'], mus1), '两次重渲逐样本相同')
        finally:
            shutil.rmtree(td, ignore_errors=True)


@unittest.skipUnless(NODE, '需要 node')
class Entrypoints(unittest.TestCase):
    def test_node_front(self):
        r = H.run(['node', 'tools/audio/build.mjs', '--help'])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('用法', r.stdout)
        self.assertIn('退出码', r.stdout)
        r = H.run(['node', 'tools/audio/build.mjs', '--no-such-flag', '--json'])
        self.assertEqual(r.returncode, 2)
        self.assertEqual(H.envelope(r)['error']['code'], 'usage.unknown-option')

    @unittest.skipUnless(SH, '需要 sh')
    def test_sh_entry(self):
        r = H.run(['sh', 'audio/build.sh', '--help'], PYTHON=__import__('sys').executable)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('用法', r.stdout)
        r = H.run(['sh', 'audio/build.sh', '--bogus'], PYTHON=__import__('sys').executable)
        self.assertEqual(r.returncode, 2, r.stderr)


if __name__ == '__main__':
    unittest.main()
