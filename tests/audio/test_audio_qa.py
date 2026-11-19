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
        r, _, rep = self.bad('deliver-peaky', x, audio=plain)
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

    def test_empty_and_unreadable_files_are_actionable(self):
        """0 样本的 WAV 判长度、响度不通过（退出 4，不是内部错误）；不是音频的文件报 contract.audio-unreadable（退出 4）"""
        import soundfile as sf
        empty = os.path.join(self.td, 'empty.wav')
        sf.write(empty, np.zeros((0, 2)), H.SR, subtype='PCM_24')
        r, env = self.qa('--wav', empty, '--frames', '240', '--fps', '24', '--no-report')
        self.assertEqual(r.returncode, 4, r.stderr[-800:])
        self.assertEqual(set(env['data']['summary']['hardFailures']), {'audio.length', 'audio.loudness'})
        junk = os.path.join(self.td, 'junk.wav')
        with open(junk, 'w', encoding='utf-8') as f:
            f.write('这不是音频')
        r, env = self.qa('--wav', junk, '--no-report')
        self.assertEqual(r.returncode, 4, r.stderr[-800:])
        self.assertEqual(env['error']['code'], 'contract.audio-unreadable')
        self.assertIn('junk.wav', env['error']['message'])

    def test_v1_film_json_is_read(self):
        d = os.path.join(self.td, 'v1')
        os.makedirs(os.path.join(d, 'out'))
        with open(os.path.join(d, 'film.json'), 'w', encoding='utf-8') as f:
            json.dump({'route': 'c', 'title': 'v1', 'dur': 10, 'fps': 24, 'size': [1920, 1080]}, f)
        shutil.copy(self.wav, os.path.join(d, 'out', 'mix.wav'))
        r, _ = self.qa('--film', d)
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

    def test_masking_glimpse_passes_and_buried_fx_fails(self):
        """有分轨 stems/*.wav 与前景声音事件时：中高频有清晰听觉窥视窗口通过，全频带被配乐深埋 −24 dB 判 audio.masking 不通过"""
        from engine.audio import dsp as D, mixing as MX
        rng = np.random.default_rng(77)
        dur = 10.0
        n = H.N(dur)
        events = [{'id': 'slash', 'frame': 96, 'shot': 'S1', 'audio': 'slash', 'domain': 'sfx'}]
        i0 = H.N(96 / 24.0)
        ln = H.N(0.16)

        # 1) 听觉窥视通过：配乐以中低频为主，前景断水斩击在 2–6 kHz 留出干净切口
        d_ok = os.path.join(self.td, 'mask-ok')
        H.film_json(d_ok, frames=240, fps=24, cuts=(120,), events=events)
        music_low = MX.stereo(D.lp(rng.standard_normal(n), 950.0, 3) * 0.22)
        fx_cut = np.zeros((n, 2))
        burst = D.hp(D.lp(rng.standard_normal(ln), 7200.0, 2), 2100.0, 2) * np.hanning(ln) * 0.36
        fx_cut[i0:i0 + ln] = MX.stereo(burst)
        mix_ok, _, _ = MX.loudness_to(D.fade(music_low + fx_cut, 0.02, 0.05), -14.0, -1.5)
        mix_ok[0] = mix_ok[-1] = 0.0
        H.write_wav(os.path.join(d_ok, 'out', 'stems', 'music.wav'), music_low)
        H.write_wav(os.path.join(d_ok, 'out', 'stems', 'fx.wav'), fx_cut)
        H.write_wav(os.path.join(d_ok, 'out', 'mix.wav'), mix_ok)
        r_ok, _ = self.qa('--film', d_ok)
        rep_ok = H.read_json(os.path.join(d_ok, 'out', 'mix.qa.json'))
        validate_c8(self, rep_ok)
        self.assertEqual(r_ok.returncode, 0, rep_ok)
        mc_ok = next(c for c in rep_ok['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_ok['status'], 'pass', mc_ok)

        # 2) 全频带掩蔽失败：前景音效在所有临界频带都低于宽带配乐 > 22 dB
        d_bad = os.path.join(self.td, 'mask-bad')
        H.film_json(d_bad, frames=240, fps=24, cuts=(120,), events=events)
        music_wide = H.music_like(dur, seed=19) * 0.35
        fx_buried = np.zeros((n, 2))
        fx_buried[i0:i0 + ln] = MX.stereo(D.lp(rng.standard_normal(ln), 6500.0, 2) * np.hanning(ln) * 0.004)
        mix_bad, _, _ = MX.loudness_to(D.fade(music_wide + fx_buried, 0.02, 0.05), -14.0, -1.5)
        mix_bad[0] = mix_bad[-1] = 0.0
        H.write_wav(os.path.join(d_bad, 'out', 'stems', 'music.wav'), music_wide)
        H.write_wav(os.path.join(d_bad, 'out', 'stems', 'fx.wav'), fx_buried)
        H.write_wav(os.path.join(d_bad, 'out', 'mix.wav'), mix_bad)
        r_bad, _ = self.qa('--film', d_bad)
        rep_bad = H.read_json(os.path.join(d_bad, 'out', 'mix.qa.json'))
        validate_c8(self, rep_bad)
        self.assertEqual(r_bad.returncode, 4, rep_bad)
        self.assertIn('audio.masking', self.failed(rep_bad))

    def test_tightened_masking_hero_threshold_and_music_dominance_warn(self):
        """收紧掩蔽门限（需 --strict-masking）：普通事件 −6.5 dB（旧门限放行）现报 warn；hero < −1 dB 报 warn；music 比 fx+foley 高 >9 dB 触发 music_dominance 告警"""
        from engine.audio import dsp as D, mixing as MX
        rng = np.random.default_rng(131)
        dur = 6.0
        n = H.N(dur)
        i0 = H.N(2.0)
        ln = H.N(0.20)

        # 1) 普通事件最佳频带约 −6.5 dB（低于新门限 −5.0 dB，高于硬门 −12.0 dB）→ warn，且 --fail-on-warn 退出 4
        d_warn = os.path.join(self.td, 'mask-tight-warn')
        ev_norm = [{'id': 'chain', 'frame': 48, 'shot': 'S1', 'audio': 'chain', 'domain': 'sfx', 'bus': 'fx'}]
        H.film_json(d_warn, frames=144, fps=24, cuts=(), events=ev_norm)
        mus = H.music_like(dur, seed=21) * 0.30
        fx_weak = np.zeros((n, 2))
        # 复制同频谱片段并精确衰减 −6.8 dB，使各临界频带 SNR 均约 −6.8 dB ∈ (−12, −5)
        fx_weak[i0:i0 + ln] = mus[i0:i0 + ln] * (10.0 ** (-6.8 / 20.0))
        mix_w, g_w, _ = MX.loudness_to(D.fade(mus + fx_weak, 0.02, 0.05), -14.0, -1.5)
        mix_w[0] = mix_w[-1] = 0.0
        sc = 10.0 ** (g_w / 20.0)
        H.write_wav(os.path.join(d_warn, 'out', 'stems', 'music.wav'), mus * sc)
        H.write_wav(os.path.join(d_warn, 'out', 'stems', 'fx.wav'), fx_weak * sc)
        H.write_wav(os.path.join(d_warn, 'out', 'mix.wav'), mix_w)
        r_legacy, _ = self.qa('--film', d_warn)
        self.assertEqual(r_legacy.returncode, 0)
        mc_legacy = next(c for c in H.read_json(os.path.join(d_warn, 'out', 'mix.qa.json'))['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_legacy['status'], 'pass', mc_legacy)
        r_w, _ = self.qa('--film', d_warn, '--strict-masking')
        rep_w = H.read_json(os.path.join(d_warn, 'out', 'mix.qa.json'))
        validate_c8(self, rep_w)
        self.assertEqual(r_w.returncode, 0)
        mc_w = next(c for c in rep_w['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_w['status'], 'warn', mc_w)
        r_fow, _ = self.qa('--film', d_warn, '--strict-masking', '--fail-on-warn', '--no-report')
        self.assertEqual(r_fow.returncode, 4)

        # 2) hero 事件最佳频带约 −3.0 dB（高于普通门限 −5 dB，但低于 hero 门限 −1 dB） + 持续低电平 foley 使配乐高出 >9 dB → 双重检出
        d_dom = os.path.join(self.td, 'mask-hero-and-dom')
        ev_hero = [{'id': 'hat_catch', 'frame': 48, 'shot': 'S1', 'audio': 'hat_catch', 'domain': 'sfx', 'bus': 'fx', 'role': 'hero'}]
        H.film_json(d_dom, frames=144, fps=24, cuts=(), events=ev_hero)
        fx_hero_low = np.zeros((n, 2))
        fx_hero_low[i0:i0 + ln] = mus[i0:i0 + ln] * (10.0 ** (-3.0 / 20.0))
        foley_buried = MX.stereo(D.bp(rng.standard_normal(n), 300.0, 4000.0, 2) * 0.012)
        mix_d, g_d, _ = MX.loudness_to(D.fade(mus + fx_hero_low + foley_buried, 0.02, 0.05), -14.0, -1.5)
        mix_d[0] = mix_d[-1] = 0.0
        sc_d = 10.0 ** (g_d / 20.0)
        H.write_wav(os.path.join(d_dom, 'out', 'stems', 'music.wav'), mus * sc_d)
        H.write_wav(os.path.join(d_dom, 'out', 'stems', 'fx.wav'), fx_hero_low * sc_d)
        H.write_wav(os.path.join(d_dom, 'out', 'stems', 'foley.wav'), foley_buried * sc_d)
        H.write_wav(os.path.join(d_dom, 'out', 'mix.wav'), mix_d)
        r_d, _ = self.qa('--film', d_dom, '--strict-masking')
        self.assertEqual(r_d.returncode, 0)
        rep_d = H.read_json(os.path.join(d_dom, 'out', 'mix.qa.json'))
        validate_c8(self, rep_d)
        mc_d = next(c for c in rep_d['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_d['status'], 'warn', mc_d)
        self.assertEqual(mc_d['evidence']['items'][0]['status'], 'warn')
        self.assertTrue(mc_d['evidence']['musicDominance']['warn'], mc_d['evidence']['musicDominance'])
        self.assertGreater(mc_d['evidence']['musicDominance']['musicMinusFgDb'], 9.0)
        self.assertIn('music_dominance', mc_d['message'])

    def test_music_buried_warns_when_music_stem_crushed_below_master(self):
        """双向乐效平衡守卫反向检查：存在非静音 music.wav 但比总母带低 >8.5 LU 时（如 -25 LUFS vs -14 LUFS）触发 music_buried 告警。"""
        from engine.audio import dsp as D, mixing as MX
        rng = np.random.default_rng(211)
        dur = 6.0
        n = H.N(dur)
        i0 = H.N(2.0)
        ln = H.N(0.24)
        ev = [{'id': 'snap', 'frame': 48, 'shot': 'S1', 'audio': 'snap', 'domain': 'sfx', 'bus': 'fx', 'role': 'hero'}]

        # 1) 配乐被双重压死在约 -25.1 LUFS（比 -14.0 母带低 ~11.1 LU > 8.5 LU）：触发 music_buried 告警，--fail-on-warn 退出 4
        d_buried = os.path.join(self.td, 'mask-music-buried')
        H.film_json(d_buried, frames=144, fps=24, cuts=(), events=ev)
        amb_loud = D.hp(D.lp(D.decor_pair(D.pink, n, rng, corr=0.45), 5200.0, 2), 115.0, 2) * 0.14
        fx_loud = np.zeros((n, 2))
        fx_loud[i0:i0 + ln] = MX.stereo(D.bp(rng.standard_normal(ln), 1400.0, 6200.0, 2) * np.hanning(ln) * 0.55)
        mus_crushed, _, _ = MX.match_level(D.lp(H.music_like(dur, seed=31), 5600.0, 2), -29.0, 'win', 0.0, dur)
        raw_sum = D.fade(amb_loud + fx_loud + mus_crushed, 0.02, 0.05)
        mix_b, g_b, _ = MX.loudness_to(raw_sum, -14.0, -1.5)
        mix_b[0] = mix_b[-1] = 0.0
        sc_b = 10.0 ** (g_b / 20.0)
        H.write_wav(os.path.join(d_buried, 'out', 'stems', 'amb.wav'), amb_loud * sc_b)
        H.write_wav(os.path.join(d_buried, 'out', 'stems', 'fx.wav'), fx_loud * sc_b)
        H.write_wav(os.path.join(d_buried, 'out', 'stems', 'music.wav'), mus_crushed * sc_b)
        H.write_wav(os.path.join(d_buried, 'out', 'mix.wav'), mix_b)

        r_b_off, _ = self.qa('--film', d_buried, '--fail-on-warn', '--no-report')
        self.assertEqual(r_b_off.returncode, 0, '未开 --strict-masking 时既有作品不得因 music_buried 失败')
        r_b, _ = self.qa('--film', d_buried, '--strict-masking')
        self.assertEqual(r_b.returncode, 0)
        rep_b = H.read_json(os.path.join(d_buried, 'out', 'mix.qa.json'))
        validate_c8(self, rep_b)
        mc_b = next(c for c in rep_b['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_b['status'], 'warn', mc_b)
        self.assertTrue(mc_b['evidence']['musicBuried']['warn'], mc_b['evidence']['musicBuried'])
        self.assertGreater(mc_b['evidence']['musicBuried']['belowMasterLu'], 8.5)
        self.assertIn('music_buried', mc_b['message'])
        self.assertIn('配乐被过度压制', mc_b['message'])
        r_b_fow, _ = self.qa('--film', d_buried, '--strict-masking', '--fail-on-warn', '--no-report')
        self.assertEqual(r_b_fow.returncode, 4)

        # 2) 均衡乐效配比（配乐约 -16.5 LUFS，母带 -13.4 LUFS，差 ~3.1 LU ≤ 8.5 LU）+ 无配乐纯音效片（music.wav 全 0）均 0 告警通过
        d_bal = os.path.join(self.td, 'mask-music-balanced')
        H.film_json(
            d_bal, frames=144, fps=24, cuts=(), events=ev,
            audio={'mode': 'script', 'script': 'sound.py', 'targetLUFS': -13.4, 'truePeakDbTP': -1.5},
        )
        mus_healthy, _, _ = MX.match_level(D.lp(H.music_like(dur, seed=31), 5600.0, 2), -17.0, 'win', 0.0, dur)
        amb_soft, _, _ = MX.match_level(D.hp(D.lp(D.decor_pair(D.pink, n, rng, corr=0.5), 5200.0, 2), 115.0, 2), -24.0, 'win', 0.0, dur)
        mix_h, g_h, _ = MX.loudness_to(D.fade(amb_soft + fx_loud + mus_healthy, 0.02, 0.05), -13.4, -1.5)
        mix_h[0] = mix_h[-1] = 0.0
        sc_h = 10.0 ** (g_h / 20.0)
        H.write_wav(os.path.join(d_bal, 'out', 'stems', 'amb.wav'), amb_soft * sc_h)
        H.write_wav(os.path.join(d_bal, 'out', 'stems', 'fx.wav'), fx_loud * sc_h)
        H.write_wav(os.path.join(d_bal, 'out', 'stems', 'music.wav'), mus_healthy * sc_h)
        H.write_wav(os.path.join(d_bal, 'out', 'mix.wav'), mix_h)
        r_h, _ = self.qa('--film', d_bal, '--strict-masking', '--fail-on-warn')
        self.assertEqual(r_h.returncode, 0, r_h.stdout + r_h.stderr)
        rep_h = H.read_json(os.path.join(d_bal, 'out', 'mix.qa.json'))
        mc_h = next(c for c in rep_h['checks'] if c['id'] == 'audio.masking')
        self.assertEqual(mc_h['status'], 'pass', mc_h)
        self.assertFalse(mc_h['evidence']['musicBuried']['warn'])

        # 3) 无配乐影片（music.wav 为全静音）不应误报 music_buried
        d_nomus = os.path.join(self.td, 'mask-music-silent')
        H.film_json(d_nomus, frames=144, fps=24, cuts=(), events=ev)
        mix_nm, g_nm, _ = MX.loudness_to(D.fade(amb_loud + fx_loud, 0.02, 0.05), -14.0, -1.5)
        mix_nm[0] = mix_nm[-1] = 0.0
        sc_nm = 10.0 ** (g_nm / 20.0)
        H.write_wav(os.path.join(d_nomus, 'out', 'stems', 'amb.wav'), amb_loud * sc_nm)
        H.write_wav(os.path.join(d_nomus, 'out', 'stems', 'fx.wav'), fx_loud * sc_nm)
        H.write_wav(os.path.join(d_nomus, 'out', 'stems', 'music.wav'), np.zeros((n, 2)))
        H.write_wav(os.path.join(d_nomus, 'out', 'mix.wav'), mix_nm)
        r_nm, _ = self.qa('--film', d_nomus, '--strict-masking', '--fail-on-warn')
        self.assertEqual(r_nm.returncode, 0, r_nm.stdout + r_nm.stderr)



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
                        events=[{'id': 'kun-rise', 'frame': 130, 'shot': 'S2', 'audio': 'kun'}, {'id': 'late', 'frame': 300, 'shot': 'S3'},
                                {'id': 'secs-only', 't': 12.5}, {'frame': 5}])
            f = F.load(td)
            # 时间只认整数帧（作品描述把只写秒数的 t 判为没有消费者的时间字段）：只写 t 的事件不进表
            self.assertEqual(F.event_times(f), {'kun-rise': 130 / 24, 'late': 12.5})
            sp = F.shot_spans(f)
            self.assertEqual(sp['S2'], (4.0, 9.5))
            self.assertEqual(f['cuts'], [96, 228, 360])
            H.film_json(td, frames=480, fps=24, cuts=(96, 216, 360))          # 第 3 镜少 12 帧、第 4 镜多 12 帧
            sp2 = F.shot_spans(F.load(td))
            self.assertEqual((sp2['S2'][1], sp2['S3'][0]), (9.0, 9.0))
        finally:
            shutil.rmtree(td, ignore_errors=True)

    def test_windowed_lr_balance_warns_on_unilateral_burst(self):
        """1.2 s 处出现 300 ms 单侧噪声爆发（全片 mono 相关仍高）：audio.balance 精确定位告警时间码"""
        from engine.audio import qa as QA
        td = H.tmpdir('qa-bal')
        try:
            x = H.mastered(6.0, lufs=-14.0, tp=-1.5, seed=9)
            i0, i1 = H.N(1.20), H.N(1.55)
            x[i0:i1, 0] *= 2.4
            x[i0:i1, 1] *= 0.25
            wav = H.write_wav(os.path.join(td, 'skew.wav'), np.clip(x, -0.95, 0.95))
            checks, _ = QA.analyze(wav, fps=24, frames=144, target_lufs=-14.0, tol_lu=2.0)
            bal = next(c for c in checks if c['id'] == 'audio.balance')
            self.assertEqual(bal['status'], 'warn', bal)
            self.assertGreater(bal['evidence']['maxSustainedSkewDb'], 10.0)
            self.assertAlmostEqual(bal['evidence']['worstAtSec'], 1.3, delta=0.25)
        finally:
            shutil.rmtree(td, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
