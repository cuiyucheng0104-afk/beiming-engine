# -*- coding: utf-8 -*-
"""engine/audio/foundry.py：L2 声源铸造厂（按需子进程、显存守门、空闲卸载、SHA256 缓存、L3 取证、ssh 安全）。

全部离线：推理子进程用 tests/audio/_foundry_mock_worker.py（协议同 foundry_worker.py，不碰 torch 与 GPU），
显存查询用注入的探针，不依赖 nvidia-smi 与外网，三个平台都能跑。
"""
import io
import json
import os
import pathlib
import queue
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import foundry  # noqa: E402
from engine.audio._cli import CliError, EXIT  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
MOCK = os.path.join(HERE, '_foundry_mock_worker.py')
JOB = {'prompt': '宣纸被剪刀干脆地裁断', 'duration': 0.5, 'steps': 50, 'seed': 7}
ENOUGH = lambda gpu, ssh: 28 * 1024    # noqa: E731 - 空闲 28 GiB 的探针


def jload(path):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='beiming-foundry-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = os.path.join(self.tmp, 'cache')
        self.model = os.path.join(self.tmp, 'model')
        os.makedirs(self.model)
        self.workers = []
        real = foundry.Worker

        class Capturing(real):                       # 记下每个推理子进程，事后查它有没有被回收
            def __init__(me, *a, **k):
                super().__init__(*a, **k)
                self.workers.append(me)
        p = mock.patch.object(foundry, 'Worker', Capturing)
        p.start()
        self.addCleanup(p.stop)

    def mode(self, value):
        p = mock.patch.dict(os.environ, {'FOUNDRY_MOCK_MODE': value})
        p.start()
        self.addCleanup(p.stop)

    def make(self, **kw):
        base = dict(cache=self.cache, python=sys.executable, model_dir=self.model, worker_script=MOCK, vram_probe=ENOUGH, grace=2.0, timeout=60.0)
        f = foundry.Foundry(**{**base, **kw})
        self.addCleanup(f.release)
        return f

    def assertReaped(self, w):
        self.assertIsNotNone(w.proc.poll(), '推理子进程还活着')
        self.assertIsNotNone(w.proc.returncode, '推理子进程没被 wait() 回收')

    def files(self):
        return sorted(os.listdir(self.cache)) if os.path.isdir(self.cache) else []


class KeyTest(unittest.TestCase):
    def key(self, **over):
        return foundry.request_key(foundry.normalize({**JOB, **over}))[0]

    def test_key_golden_and_stable(self):
        # 键的算法是缓存的契约：改了它所有旧缓存都作废，所以钉死一个值
        self.assertEqual(self.key(), self.key())
        self.assertRegex(self.key(), r'^[0-9a-f]{64}$')
        k = foundry.request_key(foundry.normalize({'prompt': 'a', 'duration': 1, 'steps': 100, 'cfg': 4, 'sigma_shift': 5, 'seed': 0}))[0]
        self.assertEqual(k, '472563a46a06b11abe7e34a973560a8c891bae022f5ecb79b1695e4ec4e922c4')

    def test_normalization_equivalences(self):
        base = foundry.normalize(JOB)
        for variant in ({**JOB, 'duration': 0.5000000001}, {**JOB, 'steps': 50.0}, {**JOB, 'prompt': '  ' + JOB['prompt'] + '\n'},
                        {**JOB, 'prompt': unicodedata.normalize('NFD', 'é') + JOB['prompt']}, {**JOB, 'negative_prompt': None}, {**JOB, 'name': 'x'}):
            if variant['prompt'].startswith('é') or variant['prompt'].startswith('e'):
                continue                              # NFD 前缀本身改了内容，下面单独验 NFC
            self.assertEqual(foundry.normalize(variant), base, variant)
        self.assertEqual(foundry.normalize({'prompt': unicodedata.normalize('NFD', 'é')})['prompt'], unicodedata.normalize('NFC', 'é'))
        self.assertEqual(foundry.request_key(foundry.normalize(dict(reversed(list(JOB.items())))))[0], self.key())   # 字段顺序无关

    def test_every_field_changes_key(self):
        base = self.key()
        for over in ({'prompt': 'x'}, {'negative_prompt': 'noise'}, {'duration': 0.6}, {'steps': 51}, {'cfg': 4.5}, {'sigma_shift': 6.0}, {'seed': 8}):
            self.assertNotEqual(self.key(**over), base, over)
        p = foundry.normalize(JOB)
        self.assertNotEqual(foundry.request_key(p, revision='abc')[0], foundry.request_key(p)[0])
        self.assertNotEqual(foundry.request_key(p, model_id='other/model')[0], foundry.request_key(p)[0])

    def test_rejects_bad_values(self):
        for bad in ({'prompt': '  '}, {'prompt': 3}, {'duration': 0}, {'duration': 31}, {'duration': float('nan')}, {'duration': True},
                    {'steps': 0}, {'steps': 2.5}, {'cfg': -1}, {'sigma_shift': 0}, {'seed': -1}, {'seed': 'a'}, {'bogus': 1}):
            with self.assertRaises(CliError, msg=bad) as cm:
                foundry.normalize({**JOB, **bad})
            self.assertEqual(cm.exception.exit_code, EXIT.USAGE, bad)

    def test_main_process_never_imports_torch(self):
        src = pathlib.Path(foundry.__file__).read_text(encoding='utf-8')
        self.assertIsNone(re.search(r'^\s*(import|from)\s+torch\b', src, re.M))
        self.assertNotIn('torch', sys.modules)
        r = subprocess.run([sys.executable, '-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import engine.audio.foundry as f; '
                            'assert "torch" not in sys.modules, "主控 import 了 torch"', ROOT], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class FoundryTest(Base):
    def test_generate_then_cache_hit_spawns_nothing(self):
        f = self.make()
        r = f.run_batch([JOB])[0]
        self.assertEqual((r['status'], f.spawns), ('generated', 1))
        self.assertReaped(self.workers[0])           # 批处理结束，子进程已退出并回收
        self.assertEqual(self.files(), [r['key'] + '.json', r['key'] + '.wav'])
        # 新实例：没有任何推理配置（python=None）也能命中——命中根本不需要子进程
        g = foundry.Foundry(cache=self.cache, vram_probe=mock.Mock(side_effect=AssertionError('命中不该查显存')))
        r2 = g.run_batch([JOB])[0]
        self.assertEqual((r2['status'], g.spawns, r2['sha256']), ('hit', 0, r['sha256']))
        self.assertEqual(len(self.workers), 1)

    def test_wav_format_and_meta(self):
        import soundfile as sf
        f = self.make(revision='rev1')
        r = f.run_batch([JOB])[0]
        wav, js = f.cache.paths(r['key'])
        info = sf.info(wav)
        self.assertEqual((info.samplerate, info.channels, info.subtype, info.frames), (48000, 1, 'PCM_24', 24000))
        meta = jload(js)
        self.assertEqual(meta['request']['model'], {'id': foundry.MODEL_ID, 'revision': 'rev1'})
        self.assertEqual(meta['request']['params']['seed'], 7)
        self.assertEqual((meta['verdict'], meta['judge']['status']), ('pass', 'pass'))
        self.assertGreater(meta['judge']['bandwidth95Hz'], 12000)
        self.assertEqual((meta['license']['model'], meta['aigc']), ('Apache-2.0', True))
        self.assertEqual(meta['model']['worker']['modelFingerprint'], 'mock')
        self.assertEqual(meta['wav']['sha256'], foundry.sha256_file(wav))
        self.assertNotIn(self.tmp, json.dumps(meta))   # 旁路 json 不带本机路径

    def test_corrupt_cache_regenerates(self):
        f = self.make()
        first = f.run_batch([JOB])[0]
        wav, js = f.cache.paths(first['key'])
        good_wav, good_js = pathlib.Path(wav).read_bytes(), pathlib.Path(js).read_bytes()
        flipped = bytearray(good_wav)
        flipped[len(flipped) // 2] ^= 0xFF
        broken = {'截断的 WAV': (good_wav[:1000], good_js), '翻转一个字节': (bytes(flipped), good_js), '空 WAV': (b'', good_js),
                  '空 json': (good_wav, b''), '半截 json': (good_wav, good_js[:40]), 'json 不是对象': (good_wav, b'[]')}
        for label, (w, j) in broken.items():
            pathlib.Path(wav).write_bytes(w)
            pathlib.Path(js).write_bytes(j)
            before = f.spawns
            self.assertIsNone(f.cache.load(first['key'], foundry.request_key(foundry.normalize(JOB))[1]), label)
            r = f.run_batch([JOB])[0]
            self.assertEqual((r['status'], f.spawns), ('generated', before + 1), label)
            self.assertEqual(f.run_batch([JOB])[0]['status'], 'hit', label)
        self.assertEqual(self.files(), [first['key'] + '.json', first['key'] + '.wav'])    # 没有残留临时文件

    def test_cache_rejects_mismatched_request_and_nonfinite_wav(self):
        import soundfile as sf
        f = self.make()
        k = f.run_batch([JOB])[0]['key']
        _, request = foundry.request_key(foundry.normalize(JOB))
        self.assertIsNotNone(f.cache.load(k, request))
        other = foundry.request_key(foundry.normalize({**JOB, 'seed': 8}))[1]
        self.assertIsNone(f.cache.load(k, other), 'json 里的请求与要的不一致不能当命中')
        wav, js = f.cache.paths(k)
        bad = np.full(24000, 0.1, dtype='float32')
        bad[5] = np.nan
        sf.write(wav, bad, 48000, subtype='FLOAT', format='WAV')           # 含 NaN 的 float WAV，sha 对得上也不能用
        meta = jload(js)
        meta['wav']['sha256'] = foundry.sha256_file(wav)
        pathlib.Path(js).write_text(json.dumps(meta), encoding='utf-8')
        self.assertIsNone(f.cache.load(k, request))

    def test_concurrent_atomic_writes(self):
        f = self.make()
        k = f.run_batch([JOB])[0]['key']
        wav, js = f.cache.paths(k)
        _, request = foundry.request_key(foundry.normalize(JOB))
        meta = jload(js)
        x = np.random.default_rng(1).standard_normal(24000) * 0.1
        errors, stop = [], threading.Event()

        def writer():
            try:
                for _ in range(15):
                    f.cache.store(k, request, x, json.loads(json.dumps(meta)))
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        def reader():
            while not stop.is_set():
                m = f.cache.load(k, request)
                if m is not None and m['wav']['frames'] != 24000:
                    errors.append(AssertionError('读到半成品'))
                time.sleep(0.002)                 # 让出时间片：死循环开文件会让 Windows 的 os.replace 一直抢不到
        rs = [threading.Thread(target=reader) for _ in range(2)]
        ws = [threading.Thread(target=writer) for _ in range(4)]
        for t in rs + ws:
            t.start()
        for t in ws:
            t.join()
        stop.set()
        for t in rs:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.files(), [k + '.json', k + '.wav'], '并发写后不留临时文件')
        self.assertIsNotNone(f.cache.load(k, request))

    def test_duplicate_jobs_in_one_batch_generate_once(self):
        f = self.make()
        rs = f.run_batch([JOB, dict(JOB, name='again')])
        self.assertEqual([r['status'] for r in rs], ['generated', 'hit'])
        self.assertEqual((f.spawns, rs[1]['name']), (1, 'again'))

    def test_nan_output_is_blocked(self):
        self.mode('nan')
        f = self.make()
        with self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.CONTRACT, 'contract.worker-output'))
        r = f.run_batch([JOB, dict(JOB, seed=9)])
        self.assertEqual([x['status'] for x in r], ['failed', 'failed'])
        self.assertEqual(self.files(), [], 'NaN 不缓存不交付')
        self.assertTrue(all(w.proc.returncode is not None for w in self.workers))

    def test_bad_sample_rate_is_blocked(self):
        self.mode('badsr')
        with self.assertRaises(CliError) as cm:
            self.make().run_job(JOB)
        self.assertEqual(cm.exception.exit_code, EXIT.CONTRACT)

    def test_loud_output_is_trimmed_not_clipped(self):
        import soundfile as sf
        self.mode('loud')
        f = self.make()
        r = f.run_batch([JOB])[0]
        x, _ = sf.read(f.cache.paths(r['key'])[0], dtype='float64')
        self.assertLessEqual(np.abs(x).max(), 0.9991)
        self.assertGreater(np.abs(x).max(), 0.99)
        meta = jload(f.cache.paths(r['key'])[1])
        self.assertAlmostEqual(meta['wav']['peakTrimDb'], 20 * np.log10(0.999 / 1.5), places=2)
        self.assertEqual(sum(np.abs(x) >= 0.9999), 0, '没有截顶的样本')

    def test_quiet_output_is_untouched(self):
        f = self.make()
        r = f.run_batch([JOB])[0]
        self.assertEqual(jload(f.cache.paths(r['key'])[1])['wav']['peakTrimDb'], 0.0)


class JudgePolicyTest(Base):
    def test_annotate_by_default_keeps_reject(self):
        self.mode('silent')
        f = self.make()
        r = f.run_batch([JOB])[0]
        self.assertEqual((r['verdict'], r['accepted']), ('reject', True))
        self.assertEqual(len(self.files()), 2, '默认策略：reject 也落盘并标注')

    def test_strict_rejects_non_pass_and_does_not_respawn(self):
        self.mode('silent')
        f = self.make(strict=True)
        r = f.run_batch([JOB])[0]
        self.assertEqual((r['verdict'], r['accepted'], r['error']['code']), ('reject', False, 'contract.l3-verdict'))
        self.assertEqual(f.spawns, 1)
        again = f.run_batch([JOB])[0]                # 缓存里的 reject 在严格模式下仍不通过，且不再拉起子进程
        self.assertEqual((again['status'], again['accepted'], f.spawns), ('hit', False, 1))
        self.assertTrue(self.make(strict=False).run_batch([JOB])[0]['accepted'])

    def test_strict_suspect_and_pass(self):
        from engine.audio import sfx_judge
        real = sfx_judge.judge_wave
        verdicts = iter(['suspect', 'pass'])

        def fake(x, sr=48000, archetype='generic', **kw):
            out = real(x, sr, archetype, **kw)
            out['status'] = next(verdicts)
            return out
        with mock.patch.object(sfx_judge, 'judge_wave', fake):
            f = self.make(strict=True)
            a, b = f.run_batch([JOB, dict(JOB, seed=8)])
        self.assertEqual((a['verdict'], a['accepted'], b['verdict'], b['accepted']), ('suspect', False, 'pass', True))

    def test_archetype_is_passed_to_judge(self):
        from engine.audio import sfx_judge
        seen = []
        real = sfx_judge.judge_wave
        with mock.patch.object(sfx_judge, 'judge_wave', lambda x, sr=48000, archetype='generic', **kw: (seen.append(archetype), real(x, sr, archetype, **kw))[1]):
            self.make(archetype='foley_snap').run_batch([JOB])
            self.make().run_batch([dict(JOB, seed=99)])
        self.assertEqual(seen, ['foley_snap', JOB['prompt']])      # auto → 用 prompt 推断


class GuardTest(Base):
    def test_insufficient_vram_refuses_without_spawn(self):
        probe = mock.Mock(return_value=int(17.9 * 1024))
        f = self.make(vram_probe=probe)
        with self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.BUSY, 'busy.gpu-memory'))
        self.assertEqual((f.spawns, self.workers, self.files()), (0, [], []))
        probe.assert_called_once_with(0, None)

    def test_unverifiable_vram_fails_closed(self):
        f = self.make(vram_probe=mock.Mock(side_effect=CliError('env.gpu-unverified', '查不到')))
        with self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual(cm.exception.exit_code, EXIT.ENVIRONMENT)
        self.assertEqual(f.spawns, 0)

    def test_threshold_is_configurable_and_exact(self):
        self.assertEqual(self.make(vram_probe=lambda g, s: 18 * 1024).run_job(JOB)['status'], 'generated')    # 恰好 18 GiB 通过
        with self.assertRaises(CliError):
            self.make(vram_probe=lambda g, s: 18 * 1024 - 1).run_job(dict(JOB, seed=2))
        self.assertEqual(self.make(vram_probe=lambda g, s: 6 * 1024, min_free_gib=6).run_job(dict(JOB, seed=3))['status'], 'generated')

    def test_skip_flag_does_not_probe(self):
        probe = mock.Mock(side_effect=AssertionError('跳过时不该查'))
        self.assertEqual(self.make(vram_probe=probe, skip_vram_check=True).run_job(JOB)['status'], 'generated')

    def test_missing_worker_config_only_matters_for_new_generation(self):
        f = foundry.Foundry(cache=self.cache, vram_probe=ENOUGH)
        with self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.ENVIRONMENT, 'env.worker-config'))
        with self.assertRaises(CliError):
            foundry.Foundry(cache=self.cache, python=os.path.join(self.tmp, 'nope'), model_dir=self.model, vram_probe=ENOUGH).run_job(JOB)

    def test_nvidia_smi_probe_failures_are_env_errors(self):
        for result in (subprocess.CompletedProcess([], 0, '', ''), subprocess.CompletedProcess([], 0, 'N/A\n', ''), subprocess.CompletedProcess([], 9, '1000', ''),
                       subprocess.CompletedProcess([], 0, '1000\n2000\n', '')):
            with mock.patch.object(subprocess, 'run', return_value=result), self.assertRaises(CliError) as cm:
                foundry.query_free_mib(0)
            self.assertEqual(cm.exception.exit_code, EXIT.ENVIRONMENT)
        for exc in (FileNotFoundError('nvidia-smi'), subprocess.TimeoutExpired('x', 1)):
            with mock.patch.object(subprocess, 'run', side_effect=exc), self.assertRaises(CliError) as cm:
                foundry.query_free_mib(0)
            self.assertEqual(cm.exception.exit_code, EXIT.ENVIRONMENT)
        with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, ' 28913\n', '')):
            self.assertEqual(foundry.query_free_mib(1), 28913)


class LifecycleTest(Base):
    def test_batch_releases_worker_even_on_failure(self):
        self.mode('crash')
        f = self.make()
        with self.assertRaises(CliError) as cm:
            f.run_batch([JOB])
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.FAILURE, 'failure.worker-died'))
        self.assertReaped(self.workers[0])
        self.assertIsNone(f._worker)

    def test_worker_start_failure_is_env_error(self):
        self.mode('fatal_env')
        with self.assertRaises(CliError) as cm:
            self.make().run_job(JOB)
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.ENVIRONMENT, 'env.worker-start'))
        self.assertReaped(self.workers[0])

    def test_hung_worker_times_out_and_is_killed(self):
        self.mode('hang')
        f = self.make(timeout=1.5, grace=0.3)
        with self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (EXIT.TIMEOUT, 'timeout.worker'))
        self.assertReaped(self.workers[0])

    def test_serve_idle_unloads_then_respawns_on_demand(self):
        probe = mock.Mock(return_value=28 * 1024)
        f = self.make(vram_probe=probe, idle_timeout=0.6)
        inbox, out = queue.Queue(), io.StringIO()
        t = threading.Thread(target=lambda: f.serve(iter(inbox.get, None), out))
        t.start()
        self.addCleanup(lambda: (inbox.put(None), t.join(10)))

        def lines():
            return [json.loads(x) for x in out.getvalue().splitlines()]

        def wait_for(pred, secs=30.0):
            end = time.monotonic() + secs
            while time.monotonic() < end:
                if pred(lines()):
                    return lines()
                time.sleep(0.05)
            self.fail(f'等不到：{out.getvalue()}')
        inbox.put(json.dumps({'op': 'gen', 'id': 1, **JOB}) + '\n')
        got = wait_for(lambda ls: any(x.get('id') == 1 for x in ls))
        self.assertTrue(got[0]['ok'] and got[0]['result']['status'] == 'generated', got)
        self.assertEqual(len(self.workers), 1)
        wait_for(lambda ls: any(x.get('event') == 'idle-release' for x in ls))      # 空闲超时：子进程被结束并回收
        self.assertIsNone(f._worker)
        self.assertReaped(self.workers[0])
        inbox.put(json.dumps({'op': 'gen', 'id': 2, **JOB}) + '\n')               # 命中缓存：不拉起
        wait_for(lambda ls: any(x.get('id') == 2 for x in ls))
        self.assertEqual((len(self.workers), probe.call_count), (1, 1))
        inbox.put(json.dumps({'op': 'gen', 'id': 3, **dict(JOB, seed=8)}) + '\n')  # 新请求：重新过显存守门再拉起
        wait_for(lambda ls: any(x.get('id') == 3 for x in ls))
        self.assertEqual((len(self.workers), probe.call_count), (2, 2))
        inbox.put(json.dumps({'op': 'status', 'id': 4}) + '\n')
        self.assertTrue(wait_for(lambda ls: any(x.get('id') == 4 for x in ls))[-1]['workerAlive'])
        inbox.put(json.dumps({'op': 'shutdown', 'id': 5}) + '\n')
        t.join(20)
        self.assertFalse(t.is_alive())
        self.assertTrue(all(w.proc.returncode is not None for w in self.workers), '关停后零残留子进程')

    def test_serve_bad_requests_do_not_kill_the_service(self):
        f = self.make(vram_probe=lambda g, s: 1)
        out = io.StringIO()
        f.serve(iter(['{坏的\n', '[]\n', '\n', json.dumps({'op': 'zzz', 'id': 'a'}) + '\n', json.dumps({'op': 'gen', 'id': 'b', **JOB}) + '\n']), out)   # 最后一条：显存不足
        rs = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual([r['error']['code'] for r in rs], ['usage.bad-json', 'usage.bad-json', 'usage.bad-value', 'busy.gpu-memory'])
        self.assertEqual(self.workers, [])

    def test_serve_eof_releases_worker(self):
        f = self.make()
        out = io.StringIO()
        f.serve(iter([json.dumps({'op': 'gen', 'id': 1, **JOB}) + '\n']), out)
        self.assertTrue(json.loads(out.getvalue().splitlines()[0])['ok'])
        self.assertReaped(self.workers[0])

    def test_serve_dead_worker_is_replaced(self):
        self.mode('crash')
        f = self.make()
        out = io.StringIO()
        reqs = [json.dumps({'op': 'gen', 'id': i, **dict(JOB, seed=i)}) + '\n' for i in (1, 2)]
        f.serve(iter(reqs), out)
        rs = [json.loads(x) for x in out.getvalue().splitlines()]
        self.assertEqual([r['error']['code'] for r in rs], ['failure.worker-died'] * 2)
        self.assertEqual(len(self.workers), 2)


class SshTest(Base):
    BAD = ['-oProxyCommand=touch /tmp/x', '-J', 'a b', 'host;rm -rf /', 'host$(id)', 'a`b`', 'h\nx', '', ' ', 'host\n', 'a|b', 'a&b', "h'x", 'h"x', '../x', 'a/b']

    def test_bad_hosts_are_rejected_before_any_process(self):
        with mock.patch.object(subprocess, 'run', side_effect=AssertionError('不该起进程')), mock.patch.object(subprocess, 'Popen', side_effect=AssertionError('不该起进程')):
            for h in self.BAD:
                for fn in (foundry.check_host, lambda x: foundry.query_free_mib(0, x), lambda x: foundry.Foundry(cache=self.cache, ssh=x)):
                    with self.assertRaises(CliError, msg=repr(h)) as cm:
                        fn(h)
                    self.assertEqual(cm.exception.exit_code, EXIT.USAGE, repr(h))
        for ok in ('rog-5090', 'user@box.example', 'host_1', '_x'):
            self.assertEqual(foundry.check_host(ok), ok)

    def test_vram_query_over_ssh_is_a_list_without_shell(self):
        with mock.patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '28913\n', '')) as run:
            self.assertEqual(foundry.query_free_mib(2, 'rog-5090'), 28913)
        cmd, kw = run.call_args.args[0], run.call_args.kwargs
        self.assertIsInstance(cmd, list)
        self.assertEqual(cmd[:6], ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--'])
        self.assertEqual(cmd[6], 'rog-5090')
        self.assertEqual(shlex.split(cmd[7]), ['nvidia-smi', '--id=2', '--query-gpu=memory.free', '--format=csv,noheader,nounits'])
        self.assertFalse(kw.get('shell'))

    def test_remote_worker_command_quotes_every_argument(self):
        evil = "/opt/m'; touch /tmp/pwned; echo '"
        f = foundry.Foundry(cache=self.cache, ssh='rog-5090', python='/opt/venv/bin/python', model_dir=evil, pkg_dir='/opt/pkg dir', gpu=1, worker_script=MOCK)
        with mock.patch.object(shutil, 'which', return_value='/usr/bin/ssh'):
            argv = f._argv()
        self.assertEqual(argv[:7], ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', 'rog-5090'])
        self.assertEqual(len(argv), 8, '远端命令是单个参数')
        remote = shlex.split(argv[7])
        self.assertEqual(remote[:3], ['/opt/venv/bin/python', '-I', '-c'])
        self.assertEqual(remote[4:], ['--model-dir', evil, '--gpu', '1', '--pkg-dir', '/opt/pkg dir'])    # 恶意路径原样成为一个参数，没被 shell 拆开
        self.assertIn('exec(compile(base64.b64decode(', remote[3])

    def test_remote_spawn_uses_popen_list_not_shell(self):
        f = foundry.Foundry(cache=self.cache, ssh='rog-5090', python='/opt/py', model_dir='/opt/m', vram_probe=ENOUGH, worker_script=MOCK)
        with mock.patch.object(shutil, 'which', return_value='/usr/bin/ssh'), mock.patch.object(subprocess, 'Popen', side_effect=RuntimeError('stop')) as popen:
            with self.assertRaises(RuntimeError):
                f.run_job(JOB)
        self.assertIsInstance(popen.call_args.args[0], list)
        self.assertNotIn('shell', popen.call_args.kwargs)

    def test_missing_ssh_client_is_env_error(self):
        f = foundry.Foundry(cache=self.cache, ssh='rog-5090', python='/opt/py', model_dir='/opt/m', vram_probe=ENOUGH, worker_script=MOCK)
        with mock.patch.object(shutil, 'which', return_value=None), self.assertRaises(CliError) as cm:
            f.run_job(JOB)
        self.assertEqual(cm.exception.exit_code, EXIT.ENVIRONMENT)

    def test_source_has_no_shell_true(self):
        for name in ('foundry.py', 'foundry_worker.py'):
            self.assertNotRegex(pathlib.Path(HERE, '..', '..', 'engine', 'audio', name).read_text(encoding='utf-8'), r'shell\s*=\s*True|os\.system|os\.popen')


def cli(argv, **env):
    """进程内跑命令行：→ (退出码, stdout 文本, stderr 文本)"""
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = foundry.main(argv)
    return code, out.getvalue(), err.getvalue()


class CliTest(Base):
    def args(self, *extra):
        return ['gen', '--cache', self.cache, '--python', sys.executable, '--model-dir', self.model, '--skip-vram-check', *extra]

    def sub(self, argv, **env):
        e = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'BEIMING_AUDIO_L2_WORKER': MOCK, **env}
        for k in ('BEIMING_AUDIO_L2_PYTHON', 'BEIMING_AUDIO_L2_MODEL_DIR', 'BEIMING_AUDIO_L2_CACHE', 'BEIMING_AUDIO_L2_PKG'):
            e.pop(k, None) if k not in env else None
        return subprocess.run([sys.executable, '-m', 'engine.audio.foundry', *argv], cwd=ROOT, env=e, capture_output=True, text=True, encoding='utf-8', timeout=120)

    def test_help_has_no_side_effects(self):
        r = self.sub(['--help', '--cache', self.cache])
        self.assertEqual(r.returncode, 0)
        for word in ('--prompt', '--strict', '--ssh', '--min-free-gib', '--idle-timeout', '--skip-vram-check', '--python', '--model-dir', '退出码'):
            self.assertIn(word, r.stdout)
        self.assertFalse(os.path.exists(self.cache))

    def test_usage_errors_exit_2(self):
        for argv in (['gen'], ['gen', '--prompt'], ['gen', '--prompt', 'x', '--bogus'], ['gen', '--prompt', 'x', '--duration', '99'], ['gen', '--prompt', 'x', '--steps', '0'],
                     ['gen', '--prompt', 'x', '--ssh', '-oProxyCommand=x'], ['gen', '--prompt', 'x', '--ssh', 'a b'], ['nope'], ['gen', '--prompt', 'x', '--archetype', 'zzz'],
                     ['gen', '--jobs', os.path.join(self.tmp, 'j.json')], ['gen', '--prompt', 'x', '--name', '../x'], ['gen', '--prompt', 'x', '--idle-timeout', '0'],
                     ['serve', '--json']):
            code, out, err = cli(argv)
            self.assertEqual(code, EXIT.USAGE if argv != ['gen', '--jobs', os.path.join(self.tmp, 'j.json')] else EXIT.ENVIRONMENT, (argv, err))
        self.assertFalse(os.path.exists(self.cache))

    def test_bad_jobs_file(self):
        p = os.path.join(self.tmp, 'j.json')
        for body in ('{坏', '[]', '[1]', '{"jobs": "x"}', '[{"prompt": "a", "bogus": 1}]', '[{"prompt": "a", "name": "d"}, {"prompt": "b", "name": "d"}]'):
            pathlib.Path(p).write_text(body, encoding='utf-8')
            code, _, err = cli(['gen', '--jobs', p, '--out', self.tmp, '--cache', self.cache])
            self.assertEqual(code, EXIT.USAGE, (body, err))

    def test_vram_codes_in_process(self):
        with mock.patch.object(foundry, 'query_free_mib', return_value=2048):
            code, _, err = cli(['gen', '--prompt', 'x', '--cache', self.cache, '--python', sys.executable, '--model-dir', self.model])
        self.assertEqual(code, EXIT.BUSY, err)
        with mock.patch.object(foundry, 'query_free_mib', side_effect=CliError('env.gpu-unverified', '查不到')):
            code, _, err = cli(['gen', '--prompt', 'x', '--cache', self.cache, '--python', sys.executable, '--model-dir', self.model])
            self.assertEqual(code, EXIT.ENVIRONMENT, err)
            code, out, err = cli(['probe', '--json'])
            self.assertEqual(code, EXIT.ENVIRONMENT)
        self.assertEqual(json.loads(out)['error']['code'], 'env.gpu-unverified')
        with mock.patch.object(foundry, 'query_free_mib', return_value=20 * 1024):
            code, out, _ = cli(['probe', '--json', '--python', sys.executable, '--model-dir', self.model])
        env = json.loads(out)
        self.assertEqual((code, env['data']['freeMiB'], env['data']['workerConfigured']), (0, 20480, True))

    def test_no_nvidia_smi_fails_closed_end_to_end(self):
        empty = os.path.join(self.tmp, 'empty-path')
        os.makedirs(empty)
        r = self.sub(['gen', '--prompt', 'x', '--cache', self.cache, '--python', sys.executable, '--model-dir', self.model, '--json'], PATH=empty)
        self.assertEqual(r.returncode, EXIT.ENVIRONMENT, r.stderr)
        self.assertEqual(json.loads(r.stdout)['error']['code'], 'env.gpu-unverified')
        self.assertEqual(self.files(), [])

    def test_gen_end_to_end_json_and_cache_hit(self):
        out_dir = os.path.join(self.tmp, 'out')
        argv = self.args('--prompt', JOB['prompt'], '--duration', '0.5', '--seed', '7', '--name', 'paper_cut', '--out', out_dir, '--json')
        r = self.sub(argv)
        self.assertEqual(r.returncode, 0, r.stderr)
        env = json.loads(r.stdout)
        self.assertEqual((env['ok'], env['command'], env['data']['spawns'], env['data']['results'][0]['status']), (True, 'audio:foundry', 1, 'generated'))
        self.assertEqual(env['outputs'][0]['kind'], 'wav')
        self.assertTrue(os.path.isfile(os.path.join(out_dir, 'paper_cut.wav')))
        self.assertEqual(env['outputs'][0]['sha256'], foundry.sha256_file(os.path.join(out_dir, 'paper_cut.wav')))
        r2 = self.sub(argv)
        env2 = json.loads(r2.stdout)
        self.assertEqual((r2.returncode, env2['data']['spawns'], env2['data']['results'][0]['status']), (0, 0, 'hit'))
        self.assertEqual(env2['outputs'][0]['sha256'], env['outputs'][0]['sha256'])
        self.assertEqual(os.listdir(out_dir), ['paper_cut.wav'])

    def test_env_vars_supply_defaults(self):
        r = self.sub(['gen', '--prompt', 'x', '--duration', '0.5', '--skip-vram-check', '--json'], BEIMING_AUDIO_L2_PYTHON=sys.executable,
                     BEIMING_AUDIO_L2_MODEL_DIR=self.model, BEIMING_AUDIO_L2_CACHE=self.cache)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.files()), 2)

    def test_dry_run_reports_hit_and_miss_without_spawning(self):
        self.assertEqual(self.sub(self.args('--prompt', JOB['prompt'], '--duration', '0.5', '--seed', '7')).returncode, 0)
        jobs = os.path.join(self.tmp, 'jobs.json')
        pathlib.Path(jobs).write_text(json.dumps({'jobs': [{'prompt': JOB['prompt'], 'duration': 0.5, 'seed': 7, 'name': 'a'}, {'prompt': '别的', 'name': 'b'}]}), encoding='utf-8')
        before = self.files()
        r = self.sub(['gen', '--jobs', jobs, '--cache', self.cache, '--steps', '100', '--dry-run', '--json'])
        env = json.loads(r.stdout)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(env['data']['wouldSpawn'], True)
        self.assertEqual([j['name'] for j in env['data']['jobs']], ['a', 'b'])
        self.assertEqual(self.files(), before)

    def test_jobs_file_flags_are_defaults(self):
        jobs = os.path.join(self.tmp, 'jobs.json')
        pathlib.Path(jobs).write_text(json.dumps([{'prompt': 'one', 'name': 'one'}, {'prompt': 'two', 'name': 'two', 'duration': 0.4}]), encoding='utf-8')
        r = self.sub(self.args('--jobs', jobs, '--duration', '0.5', '--steps', '10', '--json'))
        self.assertEqual(r.returncode, 0, r.stderr)
        rs = json.loads(r.stdout)['data']['results']
        self.assertEqual((len(rs), json.loads(r.stdout)['data']['spawns']), (2, 1), '一批只拉起一次子进程')
        metas = [jload(os.path.join(self.cache, x['key'] + '.json'))['request']['params'] for x in rs]
        self.assertEqual([(m['duration'], m['steps']) for m in metas], [(0.5, 10), (0.4, 10)])

    def test_strict_exit_4_and_default_exit_0(self):
        r = self.sub(self.args('--prompt', 'x', '--duration', '0.5', '--strict', '--json'), FOUNDRY_MOCK_MODE='silent')
        env = json.loads(r.stdout)
        self.assertEqual((r.returncode, env['error']['code']), (EXIT.CONTRACT, 'contract.foundry-rejected'))
        self.assertEqual(env['data']['results'][0]['verdict'], 'reject')
        r = self.sub(self.args('--prompt', 'x', '--duration', '0.5', '--json'), FOUNDRY_MOCK_MODE='silent')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(any(w['code'] == 'foundry.l3-reject' for w in json.loads(r.stdout)['warnings']))

    def test_nan_exit_4(self):
        r = self.sub(self.args('--prompt', 'x', '--duration', '0.5', '--json'), FOUNDRY_MOCK_MODE='nan')
        self.assertEqual(r.returncode, EXIT.CONTRACT, r.stderr)
        self.assertEqual(self.files(), [])

    def test_serve_end_to_end_shutdown(self):
        p = subprocess.Popen([sys.executable, '-m', 'engine.audio.foundry', 'serve', '--cache', self.cache, '--python', sys.executable, '--model-dir', self.model,
                              '--skip-vram-check', '--idle-timeout', '30'], cwd=ROOT, env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'BEIMING_AUDIO_L2_WORKER': MOCK},
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            p.stdin.write((json.dumps({'op': 'gen', 'id': 1, **JOB}) + '\n').encode())
            p.stdin.write(b'{"op":"shutdown","id":2}\n')
            p.stdin.flush()
            out, _ = p.communicate(timeout=120)
        finally:
            p.kill()
        rs = [json.loads(x) for x in out.decode('utf-8').splitlines()]
        self.assertEqual((rs[0]['ok'], rs[0]['result']['status'], rs[1]['event'], p.returncode), (True, 'generated', 'shutdown', 0))


class WiringTest(unittest.TestCase):
    def test_node_options_match_python_parser(self):
        text = pathlib.Path(ROOT, 'tools', 'audio', 'foundry.mjs').read_text(encoding='utf-8')
        body = text[text.index('options: {'):text.index('examples:')]
        node = set(re.findall(r"^\s{4}'?([a-z][a-z-]*)'?:\s*(?:str|int|num|flag)\(", body, re.M))
        py = {s[2:] for a in foundry.make_parser()._actions for s in a.option_strings if s.startswith('--')} - {'help', 'json', 'quiet'}
        self.assertEqual(node, py)

    def test_npm_script_registered(self):
        scripts = json.loads(pathlib.Path(ROOT, 'package.json').read_text(encoding='utf-8'))['scripts']
        self.assertEqual(scripts['audio:foundry'], 'node tools/audio/foundry.mjs')


if __name__ == '__main__':
    unittest.main()
