# -*- coding: utf-8 -*-
"""《北冥》混音时间表的回归测试：照 cues.json 的说明“改 t 再跑”，混音要跟着走、出错要说清楚（R48、R49）。

每个用例把 audio/、engine/audio/ 和 tools/lib/cli.py 拷到临时目录，只改那里的 cues.json，再跑一遍 mix.py（每个用例约 10 秒），不碰仓库里的产物。
用法（仓库根）：python -m unittest audio.test_timeline
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKIP = shutil.ignore_patterns('stems', 'check', 'samples', '__pycache__', 'test_*.py')


def run_mix(edit):
    """在临时目录里改 cues.json 并跑 mix.py → (退出码, stderr, 临时目录)"""
    td = tempfile.mkdtemp(prefix='beiming-timeline-')
    shutil.copytree(HERE, os.path.join(td, 'audio'), ignore=SKIP)
    os.makedirs(os.path.join(td, 'engine'))
    shutil.copytree(os.path.join(ROOT, 'engine', 'audio'), os.path.join(td, 'engine', 'audio'), ignore=SKIP)
    shutil.copy(os.path.join(ROOT, 'engine', '__init__.py'), os.path.join(td, 'engine')) if os.path.exists(os.path.join(ROOT, 'engine', '__init__.py')) else None
    os.makedirs(os.path.join(td, 'tools', 'lib'))          # 命令约定库（mix.py 经 engine/audio/_cli.py 按路径加载它解析参数）
    shutil.copy(os.path.join(ROOT, 'tools', 'lib', 'cli.py'), os.path.join(td, 'tools', 'lib'))
    p = os.path.join(td, 'audio', 'cues.json')
    with open(p, encoding='utf-8') as fh:
        d = json.load(fh)
    edit(d)
    with open(p, 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, indent=1)
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    env.setdefault('NUMBA_CACHE_DIR', os.path.join(tempfile.gettempdir(), 'beiming-numba-cache'))
    r = subprocess.run([sys.executable, os.path.join(td, 'audio', 'mix.py')], cwd=td, env=env, capture_output=True, text=True)
    return r.returncode, r.stderr, td


def move_shot(d, sid, t):
    """把镜头 sid 的切点挪到 t：前一段的 t_end、跟着镜头走的环境声 cue 一起改（frame 也跟着改）"""
    sh = {s['id']: s for s in d['shots']}
    old, prev = sh[sid]['t'], {'B': 'A', 'C': 'B'}[sid]
    sh[sid]['t'] = t
    sh[prev]['t_end'] = t
    for c in d['cues']:
        if c.get('shot') == sid and abs(c['t'] - old) < 1e-9:
            c['t'], c['frame'] = t, t * 24
        if c.get('shot') == prev and abs(c.get('t_end', -1) - old) < 1e-9:
            c['t_end'], c['frame_end'] = t, t * 24


def set_cue(d, cid, t):
    for c in d['cues']:
        if c['id'] == cid:
            c['t'], c['frame'] = t, t * 24


class TestTimeline(unittest.TestCase):
    def tearDown(self):
        if getattr(self, 'td', None):
            shutil.rmtree(self.td, ignore_errors=True)

    def test_moving_cut_keeps_ambience_continuous(self):
        """镜头 B 从 3.0 挪到 3.6：环境声底层按镜头长度生成，3.4–3.6 s 不能出现空洞"""
        rc, err, self.td = run_mix(lambda d: move_shot(d, 'B', 3.6))
        self.assertEqual(rc, 0, err[-800:])
        amb, sr = sf.read(os.path.join(self.td, 'audio', 'stems', 'amb.wav'), dtype='float64')
        for a in np.arange(3.05, 4.95, 0.05):
            seg = amb[int(a * sr):int((a + 0.05) * sr)]
            self.assertGreater(10 * np.log10(np.mean(seg ** 2) + 1e-30), -50, f'环境声在 {a:.2f} s 掉成空洞')
        with open(os.path.join(self.td, 'audio', 'check', 'render.json'), encoding='utf-8') as fh:
            rep = json.load(fh)
        self.assertEqual(rep['timeline']['cuts'], [3.6, 5.0])
        self.assertEqual(rep['warnings'], [])

    def test_glimpse_cut_off_reports_clearly(self):
        """鲲影挪到 2.95（镜头 A 里只剩 0.05 s）：要报出元素名和原因，而不是 NaN 之后一个空的 AssertionError"""
        rc, err, self.td = run_mix(lambda d: set_cue(d, 'kun_glimpse', 2.95))
        self.assertNotEqual(rc, 0)
        self.assertIn('kun_glimpse', err)
        self.assertIn('ValueError', err)

    def test_music_cue_edit_warns(self):
        """改配乐标注（chord_D6）不会挪动配乐：mix.py 要告警，并把告警写进 render.json"""
        rc, err, self.td = run_mix(lambda d: set_cue(d, 'chord_D6', 6.6))
        self.assertEqual(rc, 0, err[-800:])
        with open(os.path.join(self.td, 'audio', 'check', 'render.json'), encoding='utf-8') as fh:
            rep = json.load(fh)
        self.assertTrue(any('chord_D6' in w for w in rep['warnings']), rep['warnings'])


if __name__ == '__main__':
    unittest.main()
