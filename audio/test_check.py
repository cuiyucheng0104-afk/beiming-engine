# -*- coding: utf-8 -*-
"""audio/check.py 的回归测试：成片响度这一项跑不了（PATH 里没有 sh、sh 起不来）时，要把原因记进 problems、
其余各项照常测完、照常写出 audio/check/report.json，而不是带着 traceback 崩掉、连报告都没有（R47 门禁引入的回归）。

把 audio/、engine/audio/ 和 engine/render/mux.sh 拷到临时目录，先跑一遍 mix.py 生成 out/mix.wav 和分轨，
再换不同的 PATH 跑 check.py（每次约 5 秒），不碰仓库里的产物。
用法（仓库根）：python -m unittest audio.test_check
需要 ffmpeg 与 ffprobe；用符号链接搭“只有 ffmpeg / ffprobe 的 PATH”，所以只在 POSIX 上跑。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKIP = shutil.ignore_patterns('stems', 'check', 'samples', '__pycache__', 'test_*.py')
FFMPEG, FFPROBE = shutil.which('ffmpeg'), shutil.which('ffprobe')


@unittest.skipUnless(os.name == 'posix' and FFMPEG and FFPROBE, '需要 POSIX 和 ffmpeg / ffprobe')
class TestCheckWhenMuxCannotRun(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.mkdtemp(prefix='beiming-check-')
        shutil.copytree(HERE, os.path.join(cls.td, 'audio'), ignore=SKIP)
        os.makedirs(os.path.join(cls.td, 'engine', 'render'))
        shutil.copytree(os.path.join(ROOT, 'engine', 'audio'), os.path.join(cls.td, 'engine', 'audio'), ignore=SKIP)
        shutil.copy(os.path.join(ROOT, 'engine', 'render', 'mux.sh'), os.path.join(cls.td, 'engine', 'render'))
        cls.env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
        cls.env.setdefault('NUMBA_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'beiming-numba-cache'))
        r = subprocess.run([sys.executable, os.path.join(cls.td, 'audio', 'mix.py')], cwd=cls.td, env=cls.env,
                           capture_output=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            shutil.rmtree(cls.td, ignore_errors=True)
            raise RuntimeError(f'mix.py 没跑通：{r.stderr[-800:]}')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def bin_dir(self):
        """只放 ffmpeg / ffprobe 的 PATH 目录：模拟 Windows 的 PowerShell / cmd 里直接跑 python audio/check.py"""
        d = tempfile.mkdtemp(dir=self.td, prefix='bin-')
        os.symlink(FFMPEG, os.path.join(d, 'ffmpeg'))
        os.symlink(FFPROBE, os.path.join(d, 'ffprobe'))
        return d

    def run_check(self, path):
        """用给定的 PATH 跑 check.py → (CompletedProcess, report 或 None)"""
        rep = os.path.join(self.td, 'audio', 'check', 'report.json')
        if os.path.exists(rep):
            os.remove(rep)
        r = subprocess.run([sys.executable, os.path.join(self.td, 'audio', 'check.py')], cwd=self.td,
                           env=dict(self.env, PATH=path), capture_output=True, encoding='utf-8', errors='replace')
        if not os.path.exists(rep):
            return r, None
        with open(rep, encoding='utf-8') as f:
            return r, json.load(f)

    def assert_reported(self, r, rep):
        self.assertNotIn('Traceback', r.stderr, r.stderr[-1500:])
        self.assertIsNotNone(rep, f'没有写出 audio/check/report.json：{r.stderr[-800:]}')
        self.assertEqual(r.returncode, 1, r.stderr[-800:])
        self.assertFalse(rep['ok'])
        self.assertFalse(rep['deliverable']['ok'])
        self.assertTrue(any(p.startswith('成片响度测不了：') for p in rep['problems']), rep['problems'])
        for k in ('format', 'ebur128', 'mux_loudnorm', 'band_rel_db', 'edges', 'stereo', 'stems', 'figures'):
            self.assertIn(k, rep, f'{k} 这一项没测')
        # 探针根本没跑成时，不拿 loudnorm 第一遍的测量偏差去“解释”成片不达标
        self.assertFalse(any('loudnorm' in w for w in rep['warnings']), rep['warnings'])

    def test_missing_sh_still_writes_report(self):
        """PATH 里只有 ffmpeg / ffprobe：成片响度记成“找不到 sh”，退出码 1，报告照常写出"""
        r, rep = self.run_check(self.bin_dir())
        self.assert_reported(r, rep)
        self.assertIn('找不到 sh', rep['deliverable']['error'])
        self.assertIn('找不到 sh', r.stderr)

    def test_sh_that_cannot_start_still_writes_report(self):
        """PATH 里的 sh 根本起不来（不是可执行格式）：同样记进 problems，不抛异常"""
        d = self.bin_dir()
        with open(os.path.join(d, 'sh'), 'wb') as f:
            f.write(b'\x00\x01\x02 not an executable\n')
        os.chmod(os.path.join(d, 'sh'), 0o755)
        r, rep = self.run_check(d)
        self.assert_reported(r, rep)
        self.assertIn('error', rep['deliverable'])

    @unittest.skipUnless(shutil.which('sh'), '需要 sh')
    def test_normal_path_runs_mux(self):
        """正常的 PATH：真的跑了 mux.sh 并测到成片响度；退出码与报告的 ok 一致"""
        r, rep = self.run_check(os.environ.get('PATH', os.defpath))
        self.assertNotIn('Traceback', r.stderr, r.stderr[-1500:])
        self.assertIsNotNone(rep, f'没有写出 audio/check/report.json：{r.stderr[-800:]}')
        self.assertNotIn('error', rep['deliverable'], rep['deliverable'].get('error'))
        self.assertIn('I_LUFS', rep['deliverable'])
        self.assertEqual(r.returncode, 0 if rep['ok'] else 1, rep['problems'])


if __name__ == '__main__':
    unittest.main()
