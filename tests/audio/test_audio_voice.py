# -*- coding: utf-8 -*-
"""配音、字幕与口型 engine/audio/voice（npm run audio:voice）：一份 dialogue.json → 配音轨、SRT / WebVTT / ASS、texts.json、lips.json。

  · 三者同一份时间：每句第一条字幕的起点帧 = texts.json 的起点帧，与配音轨里实测的开口差 ≤ 1 帧；口型提前 1 帧；
  · 第二次构建全部命中缓存，配音轨逐样本相同；--offline 时联网服务缓存没有就退出 3；没有密钥退出 3 且不泄露任何值；
  · 字幕规则：每行 ≤ 18 字、最多两行、避头尾、超长拆条、两条之间 ≥ 2 帧、说完后吸附切点、中文标点样式、读速告警；
  · 写错的对白文件、同一个人两句叠在一起、放不下 end 都退出 4；
  · 停顿标记 <#秒#>、已录好的音频（比例分配）、让路曲线、去掉签名地址的原始响应。
只用离线的 synthetic 服务（确定的临时配音），不联网、不花钱。用法（仓库根）：python -m unittest discover -s tests/audio -p "test_audio_voice.py"
"""
import json
import os
import shutil
import unittest

import numpy as np
import soundfile as sf

import _audiotest as H
from engine.audio.voice import align as AL, dialogue as DL, providers as PV, secrets as SEC, subtitles as ST

FPS = 24
LINES = [
    {'id': 'L1', 'speaker': 'narrator', 'text': '北冥有鱼，其名为鲲。', 'at': 24},
    {'id': 'L2', 'speaker': 'girl', 'text': '鲲之大，不知其几千里也；化而为鸟，其名为鹏。', 'at': 96},
    {'id': 'L3', 'speaker': 'narrator', 'text': '鹏之背，不知其几千里也。', 'read': '鹏之背，<#0.4#>不知其几千里也。', 'at': 228},
]


def dialogue(d, lines=None, speakers=None, **extra):
    doc = {'schema': DL.SCHEMA, 'speakers': speakers or {'narrator': {'provider': 'synthetic', 'voice': 'narrator'},
                                                          'girl': {'provider': 'synthetic', 'voice': 'female', 'pan': 0.15}},
           'lines': lines if lines is not None else LINES}
    doc.update(extra)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, 'dialogue.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    return p


def voice(*args, **env):
    r = H.run(['python', '-m', 'engine.audio.voice', *args, '--json'], **env)
    return r, H.envelope(r)


class Build(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('voice')
        cls.film = os.path.join(cls.td, 'film')
        H.film_json(cls.film, frames=360, fps=FPS, cuts=(96, 216))
        dialogue(cls.film)
        cls.r, cls.env = voice('build', cls.film)
        cls.out = os.path.join(cls.film, 'out', 'dialogue')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_build_ok_and_outputs(self):
        self.assertEqual(self.r.returncode, 0, self.r.stderr[-1500:])
        kinds = sorted(o['kind'] for o in self.env['outputs'])
        self.assertEqual(kinds, ['audio', 'lips', 'manifest', 'onsets', 'subtitles', 'subtitles', 'subtitles', 'texts'])
        x, sr = sf.read(os.path.join(self.out, 'voice.wav'), always_2d=True)
        self.assertEqual((sr, x.shape), (48000, (H.N(360 / FPS), 2)))

    def test_srt_vtt_ass_texts_share_one_timing(self):
        srt = ST.read_srt(os.path.join(self.out, 'subtitles.srt'))
        texts = H.read_json(os.path.join(self.out, 'texts.json'))
        self.assertEqual(len(srt), len(texts['cues']))
        for s, c in zip(srt, texts['cues']):
            self.assertEqual(round(s['start'] * FPS), c['startFrame'])
            self.assertEqual(round(s['end'] * FPS), c['endFrame'])
            self.assertEqual(s['text'], '\n'.join(c['lines']))
        with open(os.path.join(self.out, 'subtitles.vtt'), encoding='utf-8') as f:
            vtt = f.read()
        self.assertTrue(vtt.startswith('WEBVTT\n'))
        for c in texts['cues']:
            self.assertIn(ST.fmt_vtt(c['startFrame'] / FPS) + ' --> ' + ST.fmt_vtt(c['endFrame'] / FPS), vtt)
        with open(os.path.join(self.out, 'subtitles.ass'), encoding='utf-8') as f:
            ass = f.read()
        self.assertIn('PlayResX: 1920', ass)
        for c in texts['cues']:
            self.assertIn(f'{ST.fmt_ass(c["startFrame"] / FPS)},{ST.fmt_ass(c["endFrame"] / FPS)}', ass)

    def test_voice_onset_matches_subtitle_within_one_frame(self):
        x, sr = sf.read(os.path.join(self.out, 'voice.wav'), always_2d=True)
        texts = H.read_json(os.path.join(self.out, 'texts.json'))
        manifest = H.read_json(os.path.join(self.out, 'voice.json'))
        lips = {r['id']: r for r in H.read_json(os.path.join(self.out, 'lips.json'))['lines']}
        for ln in LINES:
            first = next(c for c in texts['cues'] if c['line'] == ln['id'])
            a = H.N((ln['at'] - 6) / FPS)
            regs = AL.voiced_regions(x[a:a + H.N(1.0)], sr)
            measured = (a / sr + regs[0][0]) * FPS                         # 实测开口（帧，小数）
            self.assertLessEqual(abs(measured - first['startFrame']), 1.0, f'{ln["id"]}：实测开口第 {measured:.2f} 帧，字幕第 {first["startFrame"]} 帧')
            self.assertEqual(first['startFrame'], ln['at'], '开口帧就是 at')
            row = next(r for r in manifest['lines'] if r['id'] == ln['id'])
            self.assertEqual(row['onsetFrame'], ln['at'])
            self.assertEqual(lips[ln['id']]['startFrame'], ln['at'] - 1, '口型比声音提前 1 帧')
            self.assertGreater(max(lips[ln['id']]['open']), 0.5)

    def test_subtitle_rules(self):
        texts = H.read_json(os.path.join(self.out, 'texts.json'))['cues']
        for c in texts:
            self.assertLessEqual(len(c['lines']), 2)
            for line in c['lines']:
                self.assertLessEqual(ST.text_width(line), 18)
                self.assertFalse(line[0] in ST.CLOSE, f'行首是收尾标点：{line}')
                self.assertNotIn('，', line, '中文影视字幕：行内逗号换成空格')
                self.assertFalse(line.endswith(('。', '；')), f'行末的句号分号去掉：{line}')
        for a, b in zip(texts, texts[1:]):
            self.assertGreaterEqual(b['startFrame'] - a['endFrame'], 2, f'{a["id"]} 与 {b["id"]} 间隔不到 2 帧')
        l2 = [c for c in texts if c['line'] == 'L2']
        self.assertEqual(l2[-1]['endFrame'], 216, '说完以后离切点不到 12 帧：吸附到切点')
        l1 = next(c for c in texts if c['line'] == 'L1')
        self.assertGreaterEqual((l1['endFrame'] - l1['startFrame']) / FPS, 1.8 - 1e-9)

    def test_pause_marker_in_read(self):
        row = next(r for r in H.read_json(os.path.join(self.out, 'voice.json'))['lines'] if r['id'] == 'L3')
        plain = PV.get('synthetic', 'narrator').synth('鹏之背，不知其几千里也。', None)
        self.assertGreater(row['seconds'], len(plain.audio) / 48000 + 0.35, '读法里的 <#0.4#> 停顿要真的停')

    def test_second_build_hits_cache_and_is_identical(self):
        a, _ = sf.read(os.path.join(self.out, 'voice.wav'))
        r, env = voice('build', self.film)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        self.assertEqual(env['data']['cache'], {'hit': 3, 'miss': 0})
        b, _ = sf.read(os.path.join(self.out, 'voice.wav'))
        self.assertTrue(np.array_equal(a, b), '读缓存与第一次合成逐样本相同')

    def test_node_front(self):
        if not shutil.which('node'):
            self.skipTest('需要 node')
        r = H.run(['node', 'tools/audio/voice.mjs', 'build', self.film, '--offline', '--json'], PYTHON=__import__('sys').executable)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        env = H.envelope(r)
        self.assertEqual(env['command'], 'audio:voice')
        self.assertEqual(env['data']['cache']['miss'], 0)


class Errors(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('voice-err')
        H.film_json(self.td, frames=240, fps=FPS, cuts=(120,))

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_bad_dialogue_exit_4(self):
        dialogue(self.td, lines=[{'id': 'L1', 'speaker': 'nobody', 'text': '', 'at': -3, 'what': 1}])
        r, env = voice('check', self.td)
        self.assertEqual(r.returncode, 4)
        msg = env['error']['message']
        for frag in ('nobody', 'text', 'at', 'what'):
            self.assertIn(frag, msg)

    def test_same_speaker_overlap_exit_4(self):
        dialogue(self.td, lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼，其名为鲲。', 'at': 12},
                                 {'id': 'B', 'speaker': 'narrator', 'text': '化而为鸟。', 'at': 30}])
        r, env = voice('build', self.td)
        self.assertEqual(r.returncode, 4)
        self.assertEqual(env['error']['code'], 'contract.voice-overlap')
        self.assertIn('at 往后挪', env['error']['hint'])

    def test_line_longer_than_end_exit_4(self):
        dialogue(self.td, lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼，其名为鲲。', 'at': 12, 'end': 30}])
        r, env = voice('build', self.td)
        self.assertEqual(r.returncode, 4)
        self.assertEqual(env['error']['code'], 'contract.voice-too-long')

    def test_offline_network_provider_without_cache_exit_3(self):
        dialogue(self.td, speakers={'narrator': {'provider': 'minimax', 'voice': 'x'}},
                 lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼。', 'at': 12}])
        r, env = voice('build', self.td, '--offline')
        self.assertEqual(r.returncode, 3)
        self.assertEqual(env['error']['code'], 'env.voice-offline')

    def test_missing_key_exit_3_without_leaking(self):
        dialogue(self.td, speakers={'narrator': {'provider': 'minimax', 'voice': 'x'}},
                 lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼。', 'at': 12}])
        if SEC.get_secret('beiming-minimax', ()):
            self.skipTest('本机钥匙串里有 beiming-minimax：这条测的是没有密钥的情形')
        r, env = voice('build', self.td, MINIMAX_API_KEY='', BEIMING_MINIMAX_KEY='')
        self.assertEqual(r.returncode, 3, r.stderr[-800:])
        self.assertEqual(env['error']['code'], 'env.voice-provider')
        self.assertIn('MINIMAX_API_KEY', env['error']['hint'])

    def test_provider_override_synthetic(self):
        dialogue(self.td, speakers={'narrator': {'provider': 'minimax', 'voice': 'x'}},
                 lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼。', 'at': 12}])
        r, env = voice('build', self.td, '--provider', 'synthetic')
        self.assertEqual(r.returncode, 0, r.stderr[-800:])

    def test_recorded_audio_line(self):
        x = PV.get('synthetic', 'female').synth('北冥有鱼，其名为鲲。', None).audio
        os.makedirs(os.path.join(self.td, 'vo'))
        sf.write(os.path.join(self.td, 'vo', 'a.wav'), np.stack([x, x], 1), 48000, subtype='PCM_24')
        dialogue(self.td, lines=[{'id': 'A', 'speaker': 'narrator', 'text': '北冥有鱼，其名为鲲。', 'at': 24, 'audio': 'vo/a.wav'}])
        r, env = voice('build', self.td)
        self.assertEqual(r.returncode, 0, r.stderr[-800:])
        row = H.read_json(os.path.join(self.td, 'out', 'dialogue', 'voice.json'))['lines'][0]
        self.assertEqual((row['timing'], row['cache'], row['onsetFrame']), ('proportional', 'recorded', 24))
        self.assertIn(row['timingDetail']['anchoring'], ('pause-anchored', 'pause-anchored-partial', 'uniform'))


class Units(unittest.TestCase):
    def test_long_line_splits_and_wraps(self):
        text = '北冥有鱼，其名为鲲。鲲之大，不知其几千里也；化而为鸟，其名为鹏。鹏之背，不知其几千里也；怒而飞，其翼若垂天之云。'
        disp, toks = ST.tokens(text)
        timed = [[t.text, i * 0.2, i * 0.2 + (0 if t.kind == 'punct' else 0.2)] for i, t in enumerate(toks)]
        cues = ST.cue_texts(text, timed, ST.Config())
        self.assertGreater(len(cues), 1)
        for c in cues:
            self.assertLessEqual(len(c['lines']), 2)
            self.assertTrue(all(ST.text_width(ln) <= 18 for ln in c['lines']), c['lines'])
            self.assertLessEqual(c['t1'] - c['t0'], 7.0 + 1e-9)
        self.assertEqual(''.join(''.join(c['lines']) for c in cues).replace(' ', ''),
                         text.replace('，', '').replace('。', '').replace('；', ''))

    def test_kinsoku_never_breaks_before_closing_punct(self):
        text = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未，申酉戌亥。'
        disp, toks = ST.tokens(text)
        timed = [[t.text, i * 0.1, i * 0.1 + 0.1] for i, t in enumerate(toks)]
        for c in ST.cue_texts(text, timed, ST.Config(punct='keep')):
            for ln in c['lines']:
                self.assertNotIn(ln[0], ST.CLOSE)

    def test_latin_punctuation_kept(self):
        text = 'Hello world, this is a test.'
        disp, toks = ST.tokens(text)
        timed = [[t.text, i * 0.3, i * 0.3 + 0.3] for i, t in enumerate(toks)]
        c = ST.cue_texts(text, timed, ST.Config())[0]
        self.assertEqual(c['lines'], ['Hello world, this is a test.'])
        self.assertAlmostEqual(c['chars'], 10.5)

    def test_gap_and_reading_speed(self):
        cues = [{'id': 'a', 't0': 1.0, 't1': 1.5, 'chars': 30, 'lines': ['x']}, {'id': 'b', 't0': 1.6, 't1': 3.0, 'chars': 4, 'lines': ['y']}]
        cues, warns = ST.layout_frames(cues, FPS, ST.Config())
        self.assertGreaterEqual(cues[1]['startFrame'] - cues[0]['endFrame'], 2)
        self.assertIn('subtitle.reading-speed', {w['code'] for w in warns})

    def test_config_rejects_unknown_fields(self):
        with self.assertRaises(ValueError):
            ST.Config(maxChar=18)

    def test_duck_curve(self):
        t = np.arange(0, 6, 0.01)
        g = DL.duck_curve(t, [(2.0, 3.0)], depth=0.5)
        self.assertAlmostEqual(float(g[t < 1.5].min()), 1.0)
        self.assertAlmostEqual(float(g[(t > 2.1) & (t < 2.9)].max()), 0.5)
        self.assertAlmostEqual(float(g[t > 3.5].min()), 1.0)

    def test_strip_signed_and_secret_order(self):
        signed = 'https://oss.example.com/a/b.json?' + '&'.join(['Expires=1', 'OSSAccess' + 'KeyId=demo', 'Signa' + 'ture=demo'])   # 拼出来：仓库里不留签名链接的字面量
        raw = {'data': {'subtitle_file': signed},
               'trace_id': 'abc', 'extra_info': {'usage_characters': 5}}
        s = PV.strip_signed(raw)
        self.assertEqual(s['data']['subtitle_file'], 'https://oss.example.com/a/b.json')
        self.assertNotIn('trace_id', s)
        os.environ['BEIMING_TEST_SECRET_A'] = ''
        os.environ['BEIMING_TEST_SECRET_B'] = 'from-env'
        try:
            self.assertEqual(SEC.get_secret('beiming-test-nonexistent', ('BEIMING_TEST_SECRET_A', 'BEIMING_TEST_SECRET_B')), 'from-env')
        finally:
            del os.environ['BEIMING_TEST_SECRET_A'], os.environ['BEIMING_TEST_SECRET_B']
        hint = SEC.how_to_set('beiming-minimax', ('MINIMAX_API_KEY',))
        self.assertIn('security add-generic-password', hint)
        self.assertIn('secret-tool store', hint)
        self.assertIn('cmdkey /generic', hint)

    def test_cache_key_covers_identity_and_text(self):
        from engine.audio.voice import cache as CA
        p = PV.get('synthetic', 'narrator', None, {'speed': 1.0})
        k = CA.key(p.identity(), '北冥')
        self.assertEqual(k, CA.key(PV.get('synthetic', 'narrator', None, {'speed': 1.0, 'timeout': 9}).identity(), '北冥'), '超时不影响声音，不进键')
        self.assertNotEqual(k, CA.key(PV.get('synthetic', 'narrator', None, {'speed': 1.1}).identity(), '北冥'))
        self.assertNotEqual(k, CA.key(PV.get('synthetic', 'female', None, {'speed': 1.0}).identity(), '北冥'))
        self.assertNotEqual(k, CA.key(p.identity(), '北溟'))


if __name__ == '__main__':
    unittest.main()
