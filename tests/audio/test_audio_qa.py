# -*- coding: utf-8 -*-
"""声音 QA 门 engine/audio/qa.py（npm run audio:qa）：按 film.json 判定混音，硬项不达标退出 4，报告是附录 C8 的结构。
响度在哪一步定：film.json 写了 audio.targetLUFS → 声音脚本自己母带（查响度、真峰值）；没写 → 封装时线性增益（查峰值余量）。

合格的合成混音通过；单声道、截短、过载（整体 +6 dB）、切点爆音、直流、反相六类坏样本都判不通过（退出码 4），并指出是哪一项；
用法错误退出 2、找不到混音或作品描述退出 3；报告的结构与 tools/qa 的 qa/report.json 一致（逐项 id/status/value/expected/evidence）。
不需要 ffmpeg（测量全在 numpy 里做），几秒跑完。用法（仓库根）：python -m unittest discover -s tests/audio -p "test_audio_qa.py"
"""
import json
import os
import shutil
import unittest

import numpy as np

import _audiotest as H
from engine.audio import stream as S
from engine.audio import meter as M

STATUSES = {'pass', 'fail', 'warn', 'waived'}


def validate_c8(t, rep):
    """与 tools/qa/lib/report.mjs 的 validateReport 同一组规则（附录 C8）"""
    t.assertEqual(rep['schemaVersion'], 1)
    t.assertIsInstance(rep['ok'], bool)
    t.assertTrue(rep['profile'] and isinstance(rep['profile']['id'], str) and rep['profile']['id'])
    if rep['input'] is not None:
        t.assertTrue(rep['input']['path'])
        t.assertRegex(rep['input']['sha256'], r'^[0-9a-f]{64}$')
    t.assertTrue(rep['checks'])
    ids = [c['id'] for c in rep['checks']]
    t.assertEqual(len(ids), len(set(ids)), '检查 id 不能重复')
    for c in rep['checks']:
        t.assertIn(c['status'], STATUSES)
        for k in ('value', 'expected', 'evidence'):
            t.assertIn(k, c)
    t.assertEqual(rep['ok'], not any(c['status'] == 'fail' for c in rep['checks']), 'ok 要与 checks 一致')


class QaGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('audio-qa')
        cls.film = os.path.join(cls.td, 'film')
        H.film_json(cls.film, frames=240, fps=24, cuts=(120,))
        cls.good = H.mastered(10.0, lufs=-14.0, tp=-1.5, seed=3)
        cls.wav = H.write_wav(os.path.join(cls.film, 'out', 'mix.wav'), cls.good)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def qa(self, *args):
        r = H.run(['python', '-m', 'engine.audio.qa', *args, '--json'])
        return r, H.envelope(r)

    def bad(self, name, x, subtype='PCM_24', **film):
        d = os.path.join(self.td, name)
        H.film_json(d, frames=240, fps=24, cuts=(120,), **film)
        H.write_wav(os.path.join(d, 'out', 'mix.wav'), x, subtype=subtype)
        r, env = self.qa('--film', d)
        rep = H.read_json(os.path.join(d, 'out', 'mix.qa.json'))
        validate_c8(self, rep)
        return r, env, rep

    def failed(self, rep):
        return set(rep['summary']['hardFailures'])

    def test_good_mix_passes_and_report_is_c8(self):
        r, env = self.qa('--film', self.film)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])
        self.assertTrue(env['ok'])
        self.assertEqual(env['outputs'][0]['kind'], 'qa-report')
        rep = H.read_json(os.path.join(self.film, 'out', 'mix.qa.json'))
        validate_c8(self, rep)
        self.assertTrue(rep['ok'])
        self.assertEqual(rep['profile']['id'], 'web-1080p24')
        self.assertEqual(rep['film']['frameCount'], 240)
        got = {c['id'] for c in rep['checks']}
        self.assertTrue({'audio.format', 'audio.length', 'audio.overload', 'audio.loudness', 'audio.truepeak', 'audio.dc',
                         'audio.mono', 'audio.edges', 'audio.cuts', 'audio.bands'} <= got, got)
        loud = next(c for c in rep['checks'] if c['id'] == 'audio.loudness')
        self.assertAlmostEqual(loud['evidence']['integrated'], -14.0, delta=0.06)
        self.assertNotIn(H.ROOT, json.dumps(rep, ensure_ascii=False).replace('\\\\', '/'), '报告里不写仓库的本机绝对路径')

    def test_mono_fails_format(self):
        r, env, rep = self.bad('mono', self.good.mean(axis=1))
        self.assertEqual(r.returncode, 4, r.stderr[-800:])
        self.assertIn('audio.format', self.failed(rep))
        self.assertEqual(env['error']['code'], 'contract.audio-qa')

    def test_truncated_fails_length(self):
        r, _, rep = self.bad('short', self.good[:H.N(7.0)])
        self.assertEqual(r.returncode, 4)
        self.assertIn('audio.length', self.failed(rep))
        ln = next(c for c in rep['checks'] if c['id'] == 'audio.length')
        self.assertLess(ln['evidence']['diffSamples'], 0)

    def test_plus_6db_fails_overload_loudness_truepeak(self):
        r, _, rep = self.bad('loud', self.good * 10 ** (6 / 20), subtype='FLOAT')
        self.assertEqual(r.returncode, 4)
        self.assertTrue({'audio.overload', 'audio.loudness', 'audio.truepeak'} <= self.failed(rep), self.failed(rep))

    def test_click_at_cut_fails(self):
        """柔和铺底（1.5 kHz 低通）在第 120 帧（5.000 s）的切点硬拼接：一个 4 ms 衰减的台阶，没有交叉淡化 → 只有 audio.cuts 不通过"""
        x = H.mastered(10.0, seed=3, lp_hz=1500)
        c = H.N(5.0)
        x[c:] += 0.4 * np.exp(-np.arange(len(x) - c) / H.SR / 0.004)[:, None]
        r, _, rep = self.bad('click', x)
        self.assertEqual(r.returncode, 4)
        self.assertEqual(self.failed(rep), {'audio.cuts'})
        cut = next(c for c in rep['checks'] if c['id'] == 'audio.cuts')['evidence']['cuts'][0]
        self.assertEqual(cut['frame'], 120)
        r, _, rep = self.bad('noclick', H.mastered(10.0, seed=3, lp_hz=1500))
        self.assertEqual(r.returncode, 0, '同样的铺底不加台阶时要通过（判据不是噪声本身）')

    def test_dc_offset_fails(self):
        r, _, rep = self.bad('dc', self.good * 0.5 + 0.03)
        self.assertEqual(r.returncode, 4)
        self.assertIn('audio.dc', self.failed(rep))

    def test_phase_inverted_fails_mono_compat(self):
        x = self.good.copy()
        x[:, 1] = -x[:, 0]
        r, _, rep = self.bad('antiphase', x)
        self.assertEqual(r.returncode, 4)
        self.assertIn('audio.mono', self.failed(rep))

    def test_targets_come_from_film_json(self):
        """film.json 的 audio.targetLUFS 改成 −23：同一份 −14 的混音判响度不通过（目标从作品描述来，不写死）"""
        r, _, rep = self.bad('target23', self.good, audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -23, 'truePeakDbTP': -1.0})
        self.assertEqual(r.returncode, 4)
        self.assertEqual(self.failed(rep), {'audio.loudness'})

    def test_loudness_set_at_delivery_checks_headroom(self):
        """film.json 的 audio 没写 targetLUFS：响度由封装时的线性增益定（mux.sh），只记录响度、改判峰值余量"""
        plain = {'mode': 'script', 'script': 'sound.py'}
        r, env, rep = self.bad('deliver-good', self.good * 10 ** (-4 / 20), audio=plain)     # −18 LUFS、峰值余量够（A 模版的写法）
        self.assertEqual(r.returncode, 0, r.stdout[-800:])
        self.assertEqual((rep['loudnessAt'], env['data']['loudnessAt']), ('deliver', 'deliver'))
        ids = {c['id']: c for c in rep['checks']}
        self.assertNotIn('audio.truepeak', ids)
        self.assertEqual(ids['audio.loudness']['severity'], 'soft')
        self.assertEqual(ids['audio.headroom']['status'], 'pass')
        self.assertAlmostEqual(ids['audio.headroom']['evidence']['gainToTargetDb'], 4.0, delta=0.06)
        r2, env2 = self.qa('--film', os.path.join(self.td, 'deliver-good'), '--loudness-at', 'mix', '--no-report')
        self.assertEqual(r2.returncode, 4, '强制 mix：−18 LUFS 离目标 −14 太远')
        self.assertIn('audio.loudness', env2['data']['summary']['hardFailures'])

    def test_headroom_fails_when_limiting_would_be_heavy(self):
        plain = {'mode': 'script', 'script': 'sound.py'}
        bed = H.music_like(10.0, seed=6) * 0.02                        # 很轻的铺底
        clicks = np.zeros_like(bed)
        for k in range(1, 10):
            i = H.N(k - 0.5)
            clicks[i:i + H.N(0.004)] = 0.85                           # 几下很响的短瞬态：积分响度低、峰值高
        x = bed + clicks
        x[0] = x[-1] = 0.0
        r, env, rep = self.bad('deliver-peaky', x, audio=plain)
        head = next(c for c in rep['checks'] if c['id'] == 'audio.headroom')
        self.assertGreater(head['evidence']['overDb'], 3.0, head)
        self.assertEqual(r.returncode, 4)
        self.assertIn('audio.headroom', self.failed(rep))

    def test_profile_broadcast_from_cli(self):
        r, env = self.qa('--wav', self.wav, '--profile', 'broadcast-1080p25', '--frames', '250', '--fps', '25', '--no-report')
        self.assertEqual(r.returncode, 4)
        self.assertIn('audio.loudness', env['data']['summary']['hardFailures'])

    def test_usage_and_env_errors(self):
        r, env = self.qa('--frames', '240')
        self.assertEqual(r.returncode, 2)
        self.assertEqual(env['error']['code'], 'usage.missing-input')
        r, env = self.qa('--wav', self.wav, '--frames', '240')
        self.assertEqual(r.returncode, 2)
        r, env = self.qa('--film', os.path.join(self.td, 'nope'))
        self.assertEqual(r.returncode, 3)
        empty = os.path.join(self.td, 'nomix')
        H.film_json(empty)
        r, env = self.qa('--film', empty)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(env['error']['code'], 'env.mix-missing')
        r, env = self.qa('--wav', self.wav, '--profile', 'no-such-profile')
        self.assertEqual(r.returncode, 2)

    def test_v1_film_json_is_read(self):
        d = os.path.join(self.td, 'v1')
        os.makedirs(os.path.join(d, 'out'))
        with open(os.path.join(d, 'film.json'), 'w', encoding='utf-8') as f:
            json.dump({'route': 'c', 'title': 'v1', 'dur': 10, 'fps': 24, 'size': [1920, 1080]}, f)
        shutil.copy(self.wav, os.path.join(d, 'out', 'mix.wav'))
        r, env = self.qa('--film', d)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])

    def test_chunked_measurement_matches_whole_signal(self):
        """qa 按 10 秒一块读盘；分块的积分响度、真峰值与整段计算一致"""
        x = H.mastered(23.7, seed=5)
        L = S.Loudness()
        tp = S.TruePeak(4)
        for a in range(0, len(x), H.N(10)):
            L.feed(x[a:a + H.N(10)])
            tp.feed(x[a:a + H.N(10)])
        tp.finish()
        self.assertAlmostEqual(L.integrated(), M.integrated(x), delta=1e-9)
        self.assertAlmostEqual(tp.value, M.true_peak(x), delta=1e-9)



class AuthoritativeProfiles(unittest.TestCase):
    """交付档位权威表 engine/production/profiles.json（P05）的写法：audio.loudness.{integrated, tolerance, truePeak}。
    在临时目录放一份同形状的表，进程内把 filmspec.PROFILES 指过去，走与命令行同一条 qa.main 路径（不写仓库）。"""

    TABLE = {'schemaVersion': 2, 'default': 'web-1080p24', 'profiles': {
        'web-1080p24': {'video': {'width': 1920, 'height': 1080, 'fps': 24},
                        'audio': {'codec': 'aac', 'sampleRate': 48000, 'channels': 2,
                                  'loudness': {'integrated': -14, 'tolerance': 1, 'truePeak': -1, 'measure': '最终 AAC 文件'}}},
        'broadcast-1080p25': {'video': {'width': 1920, 'height': 1080, 'fps': 25},
                              'audio': {'codec': 'aac', 'sampleRate': 48000, 'channels': 2,
                                        'loudness': {'integrated': -23, 'tolerance': 0.5, 'truePeak': -1}}}}}

    def setUp(self):
        from engine.audio import filmspec as F
        self.F = F
        self.td = H.tmpdir('audio-qa-profiles')
        p = os.path.join(self.td, 'profiles.json')
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(self.TABLE, f, ensure_ascii=False)
        self.old, F.PROFILES = F.PROFILES, p

    def tearDown(self):
        self.F.PROFILES = self.old
        shutil.rmtree(self.td, ignore_errors=True)

    def qa(self, *argv):
        import io
        from engine.audio import qa as Q
        out, err = io.StringIO(), io.StringIO()
        code = Q.run(Q.main, Q.make_parser(), argv=[*argv, '--json'], command='audio:qa', stdout=out, stderr=err)
        env = json.loads(out.getvalue())
        self.assertEqual(env['exitCode'], code)
        return code, env

    def test_reads_authoritative_keys_and_legacy_draft(self):
        F = self.F
        self.assertEqual(F.loudness_targets(F.profile('broadcast-1080p25')), (-23, 0.5, -1))
        self.assertEqual(F.loudness_targets(F.profile()), (-14, 1, -1))
        draft = {'audio': {'loudness': {'integratedLUFS': -16, 'toleranceLU': 1}, 'truePeakMaxDbTP': -2}}
        self.assertEqual(F.loudness_targets(draft), (-16, 1, -2))
        self.assertEqual(F.loudness_targets({'audio': {}}), (None, None, None))

    def test_gate_runs_with_authoritative_table(self):
        film = os.path.join(self.td, 'film')
        H.film_json(film, frames=240, fps=24, cuts=(120,))                      # audio.targetLUFS = −14
        H.write_wav(os.path.join(film, 'out', 'mix.wav'), H.mastered(10.0, lufs=-14.0, tp=-1.5, seed=3))
        code, env = self.qa('--film', film, '--no-report')
        self.assertEqual(code, 0, env)
        # film.json 没写目标、强制在混音一步定：目标取档位（广播 −23），同一份 −14 的混音判响度不通过
        H.film_json(film, frames=250, fps=25, cuts=(125,), profile='broadcast-1080p25', audio={'mode': 'script', 'script': 'sound.py'})
        code, env = self.qa('--film', film, '--loudness-at', 'mix', '--no-report')
        self.assertEqual(code, 4, env)
        loud = next(c for c in env['data']['checks'] if c['id'] == 'audio.loudness')
        self.assertEqual(loud['expected'], '-23 ± 0.5 LUFS')

    def test_profile_without_targets_is_a_contract_error(self):
        table = json.loads(json.dumps(self.TABLE))
        del table['profiles']['web-1080p24']['audio']['loudness']
        with open(self.F.PROFILES, 'w', encoding='utf-8') as f:
            json.dump(table, f)
        film = os.path.join(self.td, 'film2')
        H.film_json(film, frames=240, fps=24, cuts=(120,), audio={'mode': 'script', 'script': 'sound.py'})
        H.write_wav(os.path.join(film, 'out', 'mix.wav'), H.mastered(10.0, seed=3))
        code, env = self.qa('--film', film, '--no-report')
        self.assertEqual((code, env['error']['code']), (4, 'contract.profile-audio'), env)


class FilmSpec(unittest.TestCase):
    """声音脚本取同源时间：改镜头长度只改 film.json，事件与镜头的秒数跟着变"""

    def test_event_times_and_shot_spans(self):
        from engine.audio import filmspec as F
        td = H.tmpdir('filmspec')
        try:
            H.film_json(td, frames=480, fps=24, cuts=(96, 228, 360),
                        events=[{'id': 'kun-rise', 'frame': 130, 'audio': 'kun'}, {'id': 'late', 't': 12.5}, {'frame': 5}])
            f = F.load(td)
            self.assertEqual(F.event_times(f), {'kun-rise': 130 / 24, 'late': 12.5})
            sp = F.shot_spans(f)
            self.assertEqual(sp['S2'], (4.0, 9.5))
            self.assertEqual(f['cuts'], [96, 228, 360])
            H.film_json(td, frames=480, fps=24, cuts=(96, 216, 360))          # 第 3 镜少 12 帧、第 4 镜多 12 帧
            sp2 = F.shot_spans(F.load(td))
            self.assertEqual((sp2['S2'][1], sp2['S3'][0]), (9.0, 9.0))
        finally:
            shutil.rmtree(td, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
