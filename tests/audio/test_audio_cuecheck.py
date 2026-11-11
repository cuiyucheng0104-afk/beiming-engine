# -*- coding: utf-8 -*-
"""声画拍点核对 engine/audio/cuecheck.py（npm run audio:cuecheck）：事件表与路线无关，超差退出 4。

  · C 路线：真的用 routes/c-style/template（film.json 的 tempo / cues → timeline.js → events.json / timeline.json → 模版 mix.py
    → out/score_onsets.json），原样通过；把一个打点挪 2 帧（只改 film.json 的 cues，声音跟着挪）→ 离八分网格 → 退出 4；
    只挪画面不重出声音 → 离音乐起音 → 退出 4。
  · 十六分网格与关键事件集合（style-16 那种写法）：十六分位置的打点 --grid 2 不通过、--grid 4 通过；关键事件没有同拍的音乐起音不通过。
  · A 路线：film.json v2 的 events 引用声音表（《北冥》的 audio/cues.json，经 mirror.paths = repo）：声明值都在同步容差里；
    把 ui_fail 的画面帧挪 2 帧 → 声音晚 83.3 ms → 退出 4；sync: lip 允许晚 2 帧，soft 只告警，none 不查。
  · B 路线：film.json v2 的 events 引用声音脚本登记的起音（out/score_onsets.json 的 onsets）：一致通过，错 2 帧退出 4；
    查不到登记时记告警、不静默跳过。
  · film.json v2 的 beat 事件（作品描述 P05 的写法）：timeline 的 sections / beats / bars 三种写法都换算成拍点帧；frame 与拍号对不上、
    拍号不在网格细分上、音乐起音离拍点都退出 4；网格等默认值取 film.json 的 cuecheck 段；timeline 写法不对退出 4（不静默当成没有网格）。
  · Node 入口 tools/audio/cuecheck.mjs：--json 时 stdout 只有一个信封，退出码与 Python 一侧相同；--report 是附录 C8 的结构。
  · maxDeltaMs 算上硬门同步行的 |声音 − 画面|（A 路线只有同步核对时不再恒为 0；soft 不计入）；「小节.拍」地址在整拍落在
    6 位小数秒上时进位（C 模版各打点的地址与 film.json 的 cues 一一对应）。
C 路线的用例要 node（导出 timeline.js）；其余只要 Python。用法（仓库根）：python -m unittest discover -s tests/audio -p "test_audio_cuecheck.py"
"""
import json
import os
import shutil
import unittest

import _audiotest as H

NODE = shutil.which('node')
FPS = 24


def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        if isinstance(obj, str):
            f.write(obj)
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def cuecheck(film_dir, *args, cwd=H.ROOT):
    r = H.run(['python', '-m', 'engine.audio.cuecheck', film_dir, *args, '--json'], cwd=cwd)
    return r, H.envelope(r)


def msgs(env):
    """信封里逐条的不通过 / 告警原因，拼成一段文字"""
    return '；'.join(f"{p['id']}：{'；'.join(p['problems'])}" for p in (env.get('data') or {}).get('problems', []))


@unittest.skipUnless(NODE, '需要 node（导出 C 模版的 timeline.js）')
class CRouteTemplate(unittest.TestCase):
    """C 模版原样出声音、核对；挪一个打点 2 帧"""

    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('cue-c')
        for sub in ('core', 'audio'):
            shutil.copytree(os.path.join(H.ROOT, 'engine', sub), os.path.join(cls.td, 'engine', sub), ignore=H.SKIP)
        os.makedirs(os.path.join(cls.td, 'tools', 'lib'))
        shutil.copy(os.path.join(H.ROOT, 'tools', 'lib', 'cli.py'), os.path.join(cls.td, 'tools', 'lib'))
        cls.film = os.path.join(cls.td, 'films', 'c1')
        shutil.copytree(os.path.join(H.ROOT, 'routes', 'c-style', 'template'), cls.film)
        for name in os.listdir(cls.film):
            p = os.path.join(cls.film, name)
            if name.endswith(('.js', '.json', '.py', '.html', '.md')):
                with open(p, encoding='utf-8') as f:
                    s = f.read()
                with open(p, 'w', encoding='utf-8') as f:
                    f.write(s.replace('{{TITLE}}', '试映').replace('{{NAME}}', 'c1'))
        write(os.path.join(cls.td, 'package.json'), '{"type": "module"}\n')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def build(self):
        r = H.run(['node', os.path.join(H.ROOT, 'tests', 'audio', '_dump_events.mjs'), self.film], cwd=self.td)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = H.run(['python', os.path.join(self.film, 'mix.py'), self.film], cwd=self.td)
        self.assertEqual(r.returncode, 0, r.stderr[-1500:])

    def check(self, *args):
        cfg = H.read_json(os.path.join(self.film, 'film.json'))['cuecheck']
        return cuecheck(self.film, '--grid', str(cfg['grid']), '--tol-ms', str(cfg['tolMs']), *args, cwd=self.td)

    def set_s2(self, addr):
        """打点地址只写在 film.json 的 cues（模版的唯一时间源）：[段落, 小节, 拍, 拍内分数]"""
        p = os.path.join(self.film, 'film.json')
        d = H.read_json(p)
        self.assertNotEqual(d['cues']['s2'], addr)
        d['cues']['s2'] = addr
        write(p, d)

    def test_template_then_move_one_cue_two_frames(self):
        self.build()
        rep_p = os.path.join(self.td, 'rep.json')
        r, env = self.check('--report', rep_p)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr[-800:])
        self.assertTrue(env['ok'])
        self.assertEqual(env['data']['maxDeltaMs'] <= 0.5, True, env['data'])
        # 地址与 film.json 的 cues 一一对应：timeline.json 的秒只有 6 位小数，整拍（90 BPM 的 1.333333 s）不能写成「A1.2+1/1」
        cues = H.read_json(os.path.join(self.film, 'film.json'))['cues']
        self.assertTrue(all(len(v) == 3 for v in cues.values()), '模版打点带了拍内分数：同步改这条用例')
        self.assertEqual({e['id']: e['address'] for e in H.read_json(rep_p)['events']}, {k: f'{a}{bar}.{beat}' for k, (a, bar, beat) in cues.items()})
        # 声音没重出、只挪画面：第二笔晚 2 帧（模版 90 BPM、24 fps，一拍 16 帧，2 帧 = 1/8 拍）
        fj = H.read_json(os.path.join(self.film, 'film.json'))
        self.assertEqual((fj['tempo'][0]['bpm'], fj['output']['fps'], fj['cues']['s2']), (90, 24, ['A', 1, 4]), '模版的节拍或打点改了：同步改这条用例')
        self.set_s2(['A', 1, 4, 0.125])
        H.run(['node', os.path.join(H.ROOT, 'tests', 'audio', '_dump_events.mjs'), self.film], cwd=self.td)
        r, env = self.check()
        self.assertEqual(r.returncode, 4)
        self.assertEqual(env['error']['code'], 'contract.cuecheck')
        r, env = self.check('--report', rep_p)
        rep = H.read_json(rep_p)
        bad = [e for e in rep['events'] if e['status'] == 'fail']
        self.assertEqual([e['id'] for e in bad], ['s2'])
        self.assertEqual(bad[0]['address'], 'A1.4+1/8')
        self.assertAlmostEqual(bad[0]['offGridMs'], 83.333, delta=0.01)
        self.assertAlmostEqual(bad[0]['musicOnsetMs'], 83.333, delta=0.01)
        # 声音也跟着重出：音乐起音对上了，网格仍然不对
        self.build()
        r, env = self.check('--report', rep_p)
        self.assertEqual(r.returncode, 4)
        bad = [e for e in H.read_json(rep_p)['events'] if e['status'] == 'fail']
        self.assertEqual([e['id'] for e in bad], ['s2'])
        self.assertLess(bad[0]['musicOnsetMs'], 0.5)
        # 挪回网格上（后半拍）：通过
        self.set_s2(['A', 1, 4, 0.5])
        self.build()
        r, env = self.check()
        self.assertEqual(r.returncode, 0, r.stdout)


class Address(unittest.TestCase):
    """「段小节.拍+分数」：秒只保留 6 位小数时，整拍时刻（90 BPM 的 1.333333 s ≈ 1.9999995 拍）要进位，不能写成「A1.2+1/1」；
    timeline.json 的 secs（Tempo）与 film.json v2 的 timeline（BeatGrid）两条路一致"""

    def test_whole_beats_on_rounded_seconds(self):
        from engine.audio.cuecheck import BeatGrid, _address
        from engine.audio.cues import Tempo
        tempo = Tempo([{'id': 'A', 't0': 0.0, 'bpm': 90, 'meter': 4}, {'id': 'B', 't0': 6.666667, 'bpm': 120, 'meter': 4}], FPS, digits=None)
        grid = BeatGrid({'sections': [{'id': 'A', 'start': 0, 'bpm': 90, 'meter': 4}, {'id': 'B', 'start': 160, 'bpm': 120, 'meter': 4}]}, FPS, 240)
        for t, want in ((0.0, 'A1.1'), (0.333333, 'A1.1+1/2'), (1.333333, 'A1.3'), (2.0, 'A1.4'), (2.666667, 'A2.1'), (5.333333, 'A3.1'),
                        (6.666666, 'B1.1'), (6.666667, 'B1.1'), (7.166667, 'B1.2'), (8.666667, 'B2.1')):
            self.assertEqual(_address(tempo, t, 2), want, f'timeline.json secs：{t} s')
            self.assertEqual(grid.address(t, 2), want, f'film.json timeline：{t} s')


class GridAndKeys(unittest.TestCase):
    """十六分网格、关键事件集合（style-16-swiss-motion 的写法）"""

    def setUp(self):
        self.td = H.tmpdir('cue-grid')
        write(os.path.join(self.td, 'timeline.json'), {'fps': FPS, 'secs': [{'id': 'A', 't0': 0, 'bpm': 120, 'meter': 4}], 't': {}})

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def events(self, ev, notes=(), tags=None):
        write(os.path.join(self.td, 'events.json'), {'dur': 4, 'ev': ev})
        write(os.path.join(self.td, 'out', 'score_onsets.json'), {'onsets': tags or {}, 'notes': list(notes)})

    def test_sixteenth_grid(self):
        self.events([{'t': 0.625, 'type': 'hit', 'cue': 'h1'}], notes=[0.625], tags={'h1': 0.625})   # 第 2 拍后的十六分
        r, env = cuecheck(self.td, '--grid', '2')
        self.assertEqual(r.returncode, 4, r.stdout)
        self.assertIn('离网格 125.00 ms', msgs(env))
        r, env = cuecheck(self.td, '--grid', '4')
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(env['data']['grid'], 4)

    def test_key_events_need_a_music_onset(self):
        ev = [{'t': 1.0, 'type': 'boom', 'cue': 'b1'}, {'t': 1.5, 'type': 'tick', 'cue': 't1'}]
        self.events(ev, notes=[])
        r, env = cuecheck(self.td, '--keys', 'boom')
        self.assertEqual(r.returncode, 4)
        self.assertIn('b1：关键事件没有同拍的音乐起音', msgs(env))
        self.events(ev, notes=[1.0])
        r, env = cuecheck(self.td, '--keys', 'boom')
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(env['data']['keys'], ['boom'])
        # 写在 timeline.json 的 keys 里也认
        tl = H.read_json(os.path.join(self.td, 'timeline.json'))
        tl['keys'] = ['boom']
        write(os.path.join(self.td, 'timeline.json'), tl)
        self.events(ev, notes=[])
        r, _ = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)

    def test_snap_false_is_exempt_from_grid(self):
        self.events([{'t': 0.625, 'type': 'hit', 'cue': 'h1', 'snap': False}], notes=[0.625], tags={'h1': 0.625})
        r, _ = cuecheck(self.td, '--grid', '2')
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_missing_tables_exit_3_and_bad_grid_exit_2(self):
        empty = os.path.join(self.td, 'empty')
        os.makedirs(empty)
        r, env = cuecheck(empty)
        self.assertEqual(r.returncode, 3)
        self.assertEqual(env['error']['code'], 'env.events-missing')
        r, env = cuecheck(self.td, '--grid', '0')
        self.assertEqual(r.returncode, 2)


def beiming_events(shift=None):
    """《北冥》的点状声音与画面结果帧：声音在 audio/cues.json（t 秒），画面在声音所在的那一帧（floor(t × 24)）"""
    cues = {c['id']: c for c in H.read_json(os.path.join(H.ROOT, 'audio', 'cues.json'))['cues']}
    ids = ['horn', 'pigeons', 'touch', 'wake_ping', 'kun_call', 'ui_scan', 'ui_fail', 'ui_nav']
    ev = []
    for i in ids:
        f = int(cues[i]['t'] * FPS + 1e-9) + (shift[1] if shift and shift[0] == i else 0)
        ev.append({'id': f'v_{i}', 'frame': f, 'shot': 'S1' if f < 72 else ('S2' if f < 120 else 'S3'), 'audio': i, 'visual': 'motion'})
    return ev


class ARouteSoundTable(unittest.TestCase):
    """A 路线：film.json v2 的 events 引用声音表（mirror.paths = repo 时相对仓库根）"""

    def setUp(self):
        self.td = H.tmpdir('cue-a')

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def film(self, events, cues='audio/cues.json', mirror=True):
        extra = {'mirror': {'paths': 'repo'}} if mirror else {}
        H.film_json(self.td, frames=240, fps=FPS, cuts=(72, 120), profile='beiming-1040p24', size=(1920, 1040), events=events,
                    audio={'mode': 'script', 'script': 'audio/mix.py', 'cues': cues, 'targetLUFS': -14, 'truePeakDbTP': -1.7}, **extra)

    def test_beiming_cues_within_sync_tolerance(self):
        self.film(beiming_events())
        rep_p = os.path.join(self.td, 'rep.json')
        r, env = cuecheck(self.td, '--report', rep_p)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr[-500:])
        rows = env['data']
        self.assertTrue(rows['ok'])
        # 只有同步核对（没有画面打点）时，maxDeltaMs 就是最大的 |声音 − 画面|，不再恒为 0
        rep = H.read_json(rep_p)
        self.assertEqual(rep['events'], [])
        worst = max(abs(s['deltaMs']) for s in rep['sync'])
        self.assertGreater(worst, 0)
        self.assertEqual(rows['maxDeltaMs'], rep['maxDeltaMs'])
        self.assertAlmostEqual(rows['maxDeltaMs'], worst, places=2)
        self.assertLessEqual(rows['maxDeltaMs'], 1000 / FPS, '通过时不超过 1 帧')

    def test_move_ui_fail_two_frames(self):
        self.film(beiming_events(shift=('ui_fail', -2)))            # 画面早 2 帧 → 声音晚 83.3 ms
        rep_p = os.path.join(self.td, 'rep.json')
        r, env = cuecheck(self.td, '--report', rep_p)
        self.assertEqual(r.returncode, 4, r.stdout)
        rep = H.read_json(rep_p)
        bad = [s for s in rep['sync'] if s['status'] == 'fail']
        self.assertEqual([s['audio'] for s in bad], ['ui_fail'])
        self.assertAlmostEqual(bad[0]['deltaMs'], 83.33, delta=0.01)
        self.assertAlmostEqual(rep['maxDeltaMs'], 83.33, delta=0.01)
        self.assertAlmostEqual(env['data']['maxDeltaMs'], 83.33, delta=0.01, msg='--json 信封里的 maxDeltaMs 要算上同步偏差')
        self.assertEqual(rep['schemaVersion'], 1)
        self.assertEqual({c['id'] for c in rep['checks'] if c['status'] == 'fail'}, {'cuecheck.sync'})
        self.assertNotIn(H.ROOT, json.dumps(rep, ensure_ascii=False), '报告里不写仓库的本机绝对路径')

    def test_lip_soft_none(self):
        ev = beiming_events(shift=('ui_fail', -2))
        for e in ev:
            if e['audio'] == 'ui_fail':
                e['sync'] = 'lip'                                  # 口型：允许晚 2 帧
        self.film(ev)
        r, _ = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, r.stdout)
        for e in ev:
            if e['audio'] == 'ui_fail':
                e['frame'] -= 1                                    # 晚 3 帧：口型也不行
        self.film(ev)
        r, _ = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        for e in ev:
            if e['audio'] == 'ui_fail':
                e['sync'] = 'soft'
        self.film(ev)
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, '软约束只告警')
        self.assertEqual([p['status'] for p in env['data']['problems']], ['warn'])
        self.assertLess(env['data']['maxDeltaMs'], 1000 / FPS, 'soft 只告警，不计入 maxDeltaMs')
        for e in ev:
            if e['audio'] == 'ui_fail':
                e['sync'] = 'none'
        self.film(ev)
        r, _ = cuecheck(self.td)
        self.assertEqual(r.returncode, 0)

    def test_sound_early_beyond_quarter_frame_fails(self):
        ev = beiming_events(shift=('ui_nav', 1))                    # 画面晚 1 帧 → 声音早 41.7 ms（> 0.25 帧）
        self.film(ev)
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('v_ui_nav：声音比画面早 41.7 ms', msgs(env))

    def test_unknown_sound_in_table_fails(self):
        ev = beiming_events() + [{'id': 'v_ghost', 'frame': 100, 'audio': 'no_such_cue'}]
        self.film(ev)
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('声音表里没有 no_such_cue', msgs(env))


class BRouteOnsets(unittest.TestCase):
    """B / C 路线：film.json v2 的 events 引用声音脚本登记的起音（engine.audio.cues.Onsets → out/score_onsets.json）"""

    def setUp(self):
        self.td = H.tmpdir('cue-b')

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def setup_film(self, frame, tags, events=None):
        H.film_json(self.td, frames=96, fps=FPS, cuts=(48,), events=events or [{'id': 'bell', 'frame': frame, 'audio': 'glass_bell'}])
        write(os.path.join(self.td, 'out', 'score_onsets.json'), {'onsets': tags, 'notes': sorted(tags.values())})

    def test_registered_onset_matches(self):
        self.setup_film(60, {'glass_bell': 60 / FPS})
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_two_frames_off_fails(self):
        self.setup_film(58, {'glass_bell': 60 / FPS})
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('bell：声音比画面晚 83.3 ms', msgs(env))

    def test_onset_registered_under_event_id(self):
        self.setup_film(60, {'bell': 60 / FPS})
        r, _ = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_unregistered_sound_is_a_warning_not_silence(self):
        self.setup_film(60, {'other': 1.0})
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('查不到 glass_bell 的时刻', msgs(env))
        self.assertEqual(env['data']['problems'][0]['status'], 'warn')


class FilmJsonBeats(unittest.TestCase):
    """film.json v2 的 events[].beat + timeline（sections / beats / bars），写法与 engine/production（P05）一致"""

    def setUp(self):
        self.td = H.tmpdir('cue-beats')

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def film(self, timeline, events, cuecheck=None, tags=None):
        extra = {'timeline': timeline}
        if cuecheck is not None:
            extra['cuecheck'] = cuecheck
        H.film_json(self.td, frames=96, fps=FPS, cuts=(48,), events=events, **extra)
        write(os.path.join(self.td, 'out', 'score_onsets.json'), {'onsets': tags or {}, 'notes': sorted((tags or {}).values())})

    @staticmethod
    def ev(eid, frame, beat, **kw):
        return dict({'id': eid, 'frame': frame, 'shot': 'S1' if frame < 48 else 'S2', 'beat': beat, 'visual': '落笔'}, **kw)

    def test_sections_beat_events(self):
        tl = {'sections': [{'id': 'A', 'start': 0, 'bpm': 120, 'meter': 4}]}            # 一拍 12 帧
        self.film(tl, [self.ev('h1', 30, 2.5), self.ev('h2', 60, 5)], tags={'h1': 30 / FPS})
        r, env = cuecheck(self.td, '--report', os.path.join(self.td, 'rep.json'))
        self.assertEqual(r.returncode, 0, msgs(env) + r.stderr[-500:])
        self.assertEqual(env['data']['tempo'], 'film.json timeline.sections')
        rep = H.read_json(os.path.join(self.td, 'rep.json'))
        self.assertEqual([(e['id'], e['address']) for e in rep['events']], [('h1', 'A1.3+1/2'), ('h2', 'A2.2')])
        # 十六分位置：八分网格不过、十六分过
        self.film(tl, [self.ev('h1', 27, 2.25)])
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('h1：离网格 125.00 ms', msgs(env))
        r, _ = cuecheck(self.td, '--grid', '4')
        self.assertEqual(r.returncode, 0)
        # 网格写在 film.json 的 cuecheck 段：不给 --grid 也按它判
        self.film(tl, [self.ev('h1', 27, 2.25)], cuecheck={'grid': 4, 'tolMs': 0.5})
        r, env = cuecheck(self.td)
        self.assertEqual((r.returncode, env['data']['grid']), (0, 4))

    def test_frame_must_match_beat_and_music_onset(self):
        tl = {'sections': [{'id': 'A', 'start': 0, 'bpm': 120, 'meter': 4}]}
        self.film(tl, [self.ev('h1', 32, 2.5)])                                       # 第 2.5 拍在第 30 帧
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('beat 2.5 在第 30.000 帧（取 floor → 30），事件写第 32 帧', msgs(env))
        self.film(tl, [self.ev('h1', 30, 2.5)], tags={'h1': 32 / FPS})                # 登记的音乐起音晚 2 帧
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('离音乐起音 83.33 ms', msgs(env))

    def test_beats_and_bars_forms(self):
        beats = {'beats': [0, 10, 22, 30, 41, 52, 60, 70], 'meter': 4}               # 逐拍帧表：拍长不一
        self.film(beats, [self.ev('b2', 22, 2), self.ev('b35', 35, 3.5)])           # 3.5 拍 = 30 + 0.5 × 11 = 35.5 → 第 35 帧
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, msgs(env))
        self.assertEqual(env['data']['tempo'], 'film.json timeline.beats')
        self.film(beats, [self.ev('b35', 36, 3.5)])
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('取 floor → 35', msgs(env))
        bars = {'bars': [[12, 12, 12, 12], [10, 10, 10, 10]], 'start': 0}           # 第二小节变快：拍点 48、58、68、78
        self.film(bars, [self.ev('k5', 58, 5), self.ev('k55', 63, 5.5)])
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 0, msgs(env))
        self.assertEqual(env['data']['tempo'], 'film.json timeline.bars')

    def test_bad_timeline_is_a_contract_error_not_no_grid(self):
        self.film({'sections': [{'id': 'A', 'start': 0, 'bpm': 120}], 'beats': [0, 12]}, [self.ev('h1', 24, 2)])
        r, env = cuecheck(self.td)
        self.assertEqual((r.returncode, env['error']['code']), (4, 'contract.timeline'))

    def test_beat_without_timeline_fails(self):
        H.film_json(self.td, frames=96, fps=FPS, cuts=(48,), events=[self.ev('h1', 24, 2)])
        r, env = cuecheck(self.td)
        self.assertEqual(r.returncode, 4)
        self.assertIn('写了 beat，但 film.json 没有 timeline', msgs(env))


@unittest.skipUnless(NODE, '需要 node')
class NodeFront(unittest.TestCase):
    def test_json_envelope_and_exit_codes(self):
        td = H.tmpdir('cue-node')
        try:
            H.film_json(td, frames=96, fps=FPS, cuts=(48,), events=[{'id': 'bell', 'frame': 58, 'audio': 'glass_bell'}])
            write(os.path.join(td, 'out', 'score_onsets.json'), {'onsets': {'glass_bell': 2.5}, 'notes': [2.5]})
            r = H.run(['node', 'tools/audio/cuecheck.mjs', td, '--json'], PYTHON=__import__('sys').executable)
            self.assertEqual(r.returncode, 4, r.stderr[-800:])
            env = H.envelope(r)
            self.assertEqual(env['command'], 'audio:cuecheck')
            self.assertEqual(env['error']['code'], 'contract.cuecheck')
            write(os.path.join(td, 'out', 'score_onsets.json'), {'onsets': {'glass_bell': 58 / FPS}, 'notes': []})
            r = H.run(['node', 'tools/audio/cuecheck.mjs', td, '--late-frames', '1', '--json'], PYTHON=__import__('sys').executable)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            self.assertTrue(H.envelope(r)['ok'])
        finally:
            shutil.rmtree(td, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
