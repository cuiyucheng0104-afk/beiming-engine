# -*- coding: utf-8 -*-
"""剪刀裁纸复合词表防劫持（engine/audio/sfx_vocab.py）与前景连剪序列掩蔽审计（editorial.py + qa.py）单元测试。"""
import json
import os
import shutil
import subprocess
import sys
import unittest

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(__file__))

import _audiotest as H  # noqa: E402
from engine.audio import cues as C  # noqa: E402
from engine.audio import dsp as D  # noqa: E402
from engine.audio import editorial as ED  # noqa: E402
from engine.audio import meter as M  # noqa: E402
from engine.audio import qa as QA  # noqa: E402
from engine.audio import sfx_judge as SJ  # noqa: E402
from engine.audio import sfx_vocab as SV  # noqa: E402
import tools.fetch_sfx as FS  # noqa: E402


def _make_scissor_cut_wave(dur_s: float = 0.072, seed: int = 1) -> np.ndarray:
    """生成 40–110ms 近场双刃行进裁纸测试脉冲（前半程 2.2–9.5kHz 刃口滑擦 + 后段清脆纸纤维断裂）。"""
    r = D.rng(seed)
    t = D.T(dur_s)
    u = np.clip(t / max(dur_s, 1e-4), 0.0, 1.0)
    glide_env = np.sin(np.pi * np.clip(u / 0.82, 0.0, 1.0)) ** 1.15
    glide = glide_env * D.bp(D.white(len(t), r), 2200.0, 9600.0, 2) * 0.42
    t_snap = np.maximum(0.0, t - dur_s * 0.60)
    snap = (t >= dur_s * 0.60) * np.exp(-t_snap / 0.0048) * D.bp(D.white(len(t), r), 1700.0, 11200.0, 2) * 0.92
    return D.fade(D.norm(glide + snap, 0.90), 0.002, 0.008)


class ScissorsVocabAndSeriesMaskingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('scissors-vocab-masking')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_scissors_cut_recipe_ucs_ids_and_judge_archetype(self):
        by_id = {e['catId']: e for e in SV.load_ucs()['entries']}
        rec = next((r for r in SV.DESIGNER_RECIPES if r['id'] == 'scissors_cut'), None)
        self.assertIsNotNone(rec, '必须包含 scissors_cut 复合检索配方')
        self.assertEqual(rec['power'], 'passive')
        self.assertEqual(rec['archetype'], 'foley_snap')
        self.assertIn(rec['archetype'], SJ.ARCHETYPES)
        for cid in rec['catIds']:
            self.assertIn(cid, by_id, f'无效 UCS CatID: {cid}')
        self.assertTrue({'TOOLHand', 'OBJOffc', 'PAPRRip', 'PAPRFric'} <= set(rec['catIds']))

        # 验证 45ms / 75ms / 105ms 近场裁纸声均干净通过 foley_snap 与 passive 本体守卫
        for idx, dur_s in enumerate((0.045, 0.075, 0.105), start=1):
            w = _make_scissor_cut_wave(dur_s, seed=10 + idx)
            jg = SJ.judge_wave(w, D.SR, archetype=rec['archetype'])
            ont = SJ.judge_ontology(w, D.SR, power=rec['power'], name='scissors_cutting_paper_close.wav')
            self.assertTrue(jg['ok'], jg)
            self.assertTrue(ont['ok'], ont)

    def test_compound_scissors_queries_never_hijack_to_paper_scroll_or_lego_brick(self):
        en_zh_cases = [
            ('scissors paper', 'realistic'),
            ('scissors cutting paper', 'realistic'),
            ('scissors cutting paper', 'poetic'),
            ('shears cutting cardstock', 'realistic'),
            ('papercut', 'poetic'),
            ('cut paper', 'semi_realistic'),
            ('paper snip', 'realistic'),
            ('剪子剪纸', 'poetic'),
            ('剪刀裁宣纸', 'poetic'),
            ('红纸剪窗花', 'realistic'),
            ('钢剪入画就位起剪', 'poetic'),
            ('精密金属剪刀裁切卡扣', 'semi_realistic'),
            ('金属剪刀裁切卡扣', 'semi_realistic'),
        ]
        for query, world in en_zh_cases:
            with self.subTest(query=query, world=world):
                exp_w = SV.expand_for_freesound(query, world=world)
                self.assertTrue(exp_w['recipes'], f'{query!r} 应命中复合配方')
                self.assertEqual(exp_w['recipes'][0]['id'], 'scissors_cut', exp_w['recipes'])
                self.assertEqual(exp_w['power'], 'passive')
                self.assertEqual(exp_w['archetype'], 'foley_snap')
                joined_q = ' | '.join((*exp_w['queries'], *exp_w['identityQueries'])).lower()
                self.assertNotIn('paper scroll', joined_q, f'{query!r} 不得被劫持为画卷展开: {exp_w["queries"]}')
                self.assertNotIn('lego brick', joined_q, f'{query!r} 不得被劫持为乐高积木: {exp_w["queries"]}')
                self.assertNotIn('plastic snap latch', joined_q, f'{query!r} 不得被劫持为塑料卡扣: {exp_w["queries"]}')
                self.assertTrue(
                    any(('scissors' in q.lower() or 'shears' in q.lower() or 'snip' in q.lower()) for q in exp_w['queries'][:2]),
                    f'{query!r} 首选检索词必须指向剪刀裁切: {exp_w["queries"]}',
                )

                exp_plain = SV.expand_for_freesound(query)
                self.assertEqual(exp_plain['recipes'][0]['id'], 'scissors_cut')
                plain_joined = ' | '.join(exp_plain['queries']).lower()
                self.assertNotIn('paper scroll', plain_joined)
                self.assertNotIn('lego brick', plain_joined)

        # 字面精确短语透传核验：'scissors cutting paper' 保持首位原词不丢
        lit_real = SV.expand_for_freesound('scissors cutting paper', world='realistic')
        self.assertEqual(lit_real['queries'][0], 'scissors cutting paper')
        sp_real = SV.expand_for_freesound('scissors paper', world='realistic')
        self.assertEqual(sp_real['queries'][0], 'scissors cutting paper')
        self.assertIn('scissors paper', sp_real['queries'])

        # 反向不误伤：纯材质泛词 'paper' / '宣纸画卷' 仍归属 paper_scroll_book；纯 '积木拼插' 仍归属 latch_brick_snap
        pure_paper = SV.expand_for_freesound('paper', world='realistic')
        self.assertEqual(pure_paper['recipes'][0]['id'], 'paper_scroll_book')
        self.assertEqual(pure_paper['queries'][0], 'paper scroll unroll')

        pure_scroll = SV.expand_for_freesound('宣纸画卷', world='poetic')
        self.assertEqual(pure_scroll['recipes'][0]['id'], 'paper_scroll_book')

        pure_lego = SV.search_by_world('积木拼插', world='semi_realistic')
        self.assertEqual(pure_lego['recipes'][0]['id'], 'latch_brick_snap')
        self.assertEqual(pure_lego['queries'][0], 'lego brick click')

    def test_fetch_sfx_cli_vocab_and_passive_guard_for_scissors(self):
        fetch_py = os.path.join(ROOT, 'tools', 'fetch_sfx.py')
        r_en = subprocess.run(
            [sys.executable, fetch_py, '--vocab', 'scissors paper', '--world', 'realistic', '--json', '-n', '5'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        d_en = json.loads(r_en.stdout)
        self.assertEqual(d_en['queries'][0], 'scissors cutting paper')
        self.assertNotIn('paper scroll unroll', d_en['queries'])

        r_zh = subprocess.run(
            [sys.executable, fetch_py, '--vocab', '精密金属剪刀裁切卡扣', '--world', 'semi_realistic', '--json', '-n', '5'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        d_zh = json.loads(r_zh.stdout)
        self.assertEqual(d_zh['recipes'][0]['id'], 'scissors_cut')
        self.assertNotIn('lego brick click', d_zh['queries'])

        # 无源剪刀查询自动拦截混入伺服电机的污染录音，放行近场专业拟音实录
        motor_bad = {
            'id': 10, 'name': 'Electric Hair Clipper Servo.wav', 'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
            'num_downloads': 1500, 'avg_rating': 4.6, 'num_ratings': 40,
            'description': 'Small electric motor and servo buzz', 'tags': ['scissors', 'servo'],
        }
        clean_foley = {
            'id': 11, 'name': 'Scissors Cutting Paper Close Foley.wav', 'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
            'num_downloads': 900, 'avg_rating': 4.7, 'num_ratings': 35,
            'description': 'Close-mic foley of metal scissors cutting crisp cardstock recorded with Sennheiser MKH416',
            'tags': ['scissors', 'paper', 'foley', 'cut'],
        }
        self.assertLess(FS.human_score(motor_bad, query='scissors cutting paper', world='realistic'), 0.0)
        self.assertGreater(FS.human_score(clean_foley, query='scissors cutting paper', world='realistic'), 25.0)

    def test_add_sfx_series_and_qa_check_masking_catches_buried_vs_passes_audible_cuts(self):
        self.assertIs(ED.FourStemWorkstation, ED.ThreeStemWorkstation)  # 钉住别名关系

        dur = 6.5
        fps = 24
        nf = int(round(dur * fps))
        r = D.rng(2026)

        # 十二剪由慢（四分）到快（十六分）节奏序列
        snip_times = [1.00, 1.54, 2.08, 2.62, 3.16, 3.43, 3.70, 3.97, 4.24, 4.38, 4.52, 4.66]
        snip_forces = [0.58 + 0.36 * (i / (len(snip_times) - 1)) for i in range(len(snip_times))]
        snip_takes = [_make_scissor_cut_wave(0.068 + 0.008 * k, seed=30 + k) for k in range(4)]
        snip_accents = [_make_scissor_cut_wave(0.095, seed=99)]

        t_m = D.T(dur)
        music_score = D.stereo(
            0.30 * np.sin(2 * np.pi * 146.83 * t_m)
            + 0.22 * np.sin(2 * np.pi * 220.00 * t_m)
            + 0.24 * D.bp(D.pink(D.N(dur), r), 180.0, 6200.0, 2),
            0.0,
        )
        amb_bed = D.decor_pair(D.pink, D.N(dur), r, corr=0.55) * 0.10

        # Case 1：经 FourStemWorkstation.add_sfx_series 正常编排至 fx 前景干线 → 全部 12 剪带内 SNR 达标并通过严苛 QA
        ws_ok = ED.FourStemWorkstation(dur, fps=fps, world='poetic', target_lufs=-14.0, max_tp=-1.5)
        ws_ok.set_scenes([{'in_s': 0.0, 'out_s': dur, 'wave': amb_bed, 'transition': 'hard_cut'}], target_lufs=-30.0)
        ws_ok.set_music(music_score, key='D', target_lufs=-17.8)
        scheduled_ok = ws_ok.add_sfx_series(
            'snip',
            snip_times,
            snip_takes,
            forces=snip_forces,
            accent_takes=snip_accents,
            role='accent',
            policy='anti_fatigue',
            pan=[-0.12 + 0.02 * i for i in range(len(snip_times))],
            screen_ratio=0.28,
            shot_scale='close',
            poa='intimate_dry',
            shot='cut',
            seed=56,
        )
        self.assertEqual(len(scheduled_ok), 12)
        self.assertEqual(len(ws_ok.foreground_events), 12)
        self.assertTrue(all(ev['bus'] == 'fx' and ev['role'] == 'accent' for ev in ws_ok.foreground_events))

        master_ok, stems_ok, rep_ok = ws_ok.mixdown()
        self.assertGreater(float(np.max(np.abs(stems_ok['fx']))), 0.05)
        self.assertEqual(float(np.max(np.abs(stems_ok['foley']))), 0.0)
        self.assertEqual(rep_ok['foregroundMasking']['count'], 12)
        self.assertEqual(rep_ok['foregroundMasking']['status'], 'pass', rep_ok['foregroundMasking'])
        self.assertGreaterEqual(rep_ok['foregroundMasking']['worstSnrDb'], -5.0)

        fdir_ok = os.path.join(self.td, 'papercut-audible')
        H.film_json(
            fdir_ok,
            frames=nf,
            fps=fps,
            cuts=(),
            events=[],
            audio={'mode': 'script', 'script': 'mix.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.5, 'preciseWindow': True},
        )
        wav_ok = C.write(os.path.join(fdir_ok, 'out'), master_ok, stems=stems_ok)
        # 即使 film.json 未逐帧罗列 12 剪，写出 foreground_events.json 后 qa.check_masking 与 CLI 自动全量覆盖审计（按事件时值取窗，需显式 precise_window / audio.preciseWindow）
        ws_ok.write_foreground_events(os.path.join(fdir_ok, 'out', 'stems'))

        mc_ok = QA.check_masking(wav_ok, fdir_ok, precise_window=True)
        self.assertIsNotNone(mc_ok)
        self.assertEqual(mc_ok['status'], 'pass', mc_ok)
        self.assertEqual(len(mc_ok['evidence']['items']), 12)
        for item in mc_ok['evidence']['items']:
            self.assertEqual(item['status'], 'pass', item)
            self.assertGreaterEqual(item['bestBandSnrDb'], -5.0, item)
            self.assertIn('snr2k8kDb', item)

        cli_ok = H.run(['python', '-m', 'engine.audio.qa', '--film', fdir_ok, '--fail-on-warn', '--json'])
        self.assertEqual(cli_ok.returncode, 0, cli_ok.stdout + '\n' + cli_ok.stderr)

        # Case 2：前景连剪被深埋在配乐之下（约 -16 dB SNR，复现旧版被配乐吞没场景）→ mixdown 与 qa.check_masking 均报硬失败 (fail / exit 4)
        ws_buried = ED.ThreeStemWorkstation(dur, fps=fps, world='poetic', target_lufs=-14.0, max_tp=-1.5)
        ws_buried.set_scenes([{'in_s': 0.0, 'out_s': dur, 'wave': amb_bed, 'transition': 'hard_cut'}], target_lufs=-29.0)
        ws_buried.set_music(music_score, key='D', target_lufs=-16.0, continuous_duck_db=0.0)
        ws_buried.add_sfx_series(
            'snip',
            snip_times,
            snip_takes,
            forces=snip_forces,
            role='accent',
            target_lufs=-42.0,
            duck_db=0.0,
            shot='cut',
            seed=56,
        )
        master_bad, stems_bad, rep_bad = ws_buried.mixdown()
        self.assertEqual(rep_bad['foregroundMasking']['status'], 'fail', rep_bad['foregroundMasking'])
        self.assertLess(rep_bad['foregroundMasking']['worstSnrDb'], -12.0)

        fdir_bad = os.path.join(self.td, 'papercut-buried')
        H.film_json(
            fdir_bad,
            frames=nf,
            fps=fps,
            cuts=(),
            events=[],
            audio={'mode': 'script', 'script': 'mix.py', 'targetLUFS': -14.0, 'truePeakDbTP': -1.5, 'preciseWindow': True},
        )
        # 同时验证 sfx.wav 别名分轨（与 pilot mix.py 导出 stems/sfx.wav 一致）同样被 check_masking 精确拦截
        wav_bad = C.write(
            os.path.join(fdir_bad, 'out'),
            master_bad,
            stems={'sfx': stems_bad['fx'], 'ambience': stems_bad['amb'], 'music': stems_bad['music']},
        )
        ws_buried.write_foreground_events(os.path.join(fdir_bad, 'out', 'stems'))

        mc_bad = QA.check_masking(wav_bad, fdir_bad, precise_window=True)
        self.assertIsNotNone(mc_bad)
        self.assertEqual(mc_bad['status'], 'fail', mc_bad)
        self.assertLess(min(it['bestBandSnrDb'] for it in mc_bad['evidence']['items']), -12.0)

        cli_bad = H.run(['python', '-m', 'engine.audio.qa', '--film', fdir_bad, '--json'])
        self.assertEqual(cli_bad.returncode, 4, cli_bad.stdout + '\n' + cli_bad.stderr)
        env_bad = H.envelope(cli_bad)
        self.assertIn('audio.masking', env_bad['data']['summary']['hardFailures'])

    def test_generic_material_words_keep_their_main_recipes(self):
        # 守卫只拦纸类泛词被 scissors_cut 劫持，不能让 metal / plastic / wood 失去 main 上的首选配方
        for q, rid in (('metal', 'helical_screw_thread'), ('plastic', 'latch_brick_snap'), ('wood', 'wood_carpentry_impact'),
                       ('wooden', 'wood_carpentry_impact'), ('塑料', 'latch_brick_snap'), ('paper', 'paper_scroll_book')):
            with self.subTest(query=q):
                self.assertEqual(SV.match_recipes(q)[0]['id'], rid)

    def _fx_music_film(self, name, **film_kw):
        """2.5 s：fx 分轨在 0.5 s 有 70 ms 中高频短瞬态；music 分轨 0.8 s 前很轻、之后变响。返回 (混音路径, 作品目录)。"""
        r = D.rng(11)
        n = D.N(2.5)
        fx = np.zeros(n)
        i0, ln = D.N(0.5), D.N(0.07)
        fx[i0:i0 + ln] = D.bp(D.white(ln, r), 3000.0, 7000.0, 2) * 0.15 * np.hanning(ln)
        music = D.white(n, r) * 0.002
        music[D.N(0.8):] = D.white(n - D.N(0.8), r) * 0.4
        fdir = os.path.join(self.td, name)
        H.film_json(fdir, frames=60, fps=24, cuts=(), audio={'mode': 'script', 'script': 'mix.py', 'cues': 'cues.json'}, **film_kw)
        with open(os.path.join(fdir, 'cues.json'), 'w', encoding='utf-8') as f:
            json.dump({'cues': [{'id': 'hit', 't': 0.5, 'dur': 1.2}]}, f)
        wav = C.write(os.path.join(fdir, 'out'), D.stereo(fx + music, 0.0), stems={'fx': D.stereo(fx, 0.0), 'music': D.stereo(music, 0.0)})
        return wav, fdir

    def test_default_masking_window_is_fixed_and_precise_window_is_opt_in(self):
        ev = [{'id': 'hit', 'frame': 12, 'audio': 'hit', 'domain': 'sfx'}]
        wav, fdir = self._fx_music_film('mask-window', events=ev)
        mc = QA.check_masking(wav, fdir)
        self.assertEqual(mc['status'], 'pass', mc)           # 默认：起音前 15 ms 到后 220 ms，不看 cue 声明的 dur
        mc_p = QA.check_masking(wav, fdir, precise_window=True)
        self.assertNotEqual(mc_p['status'], 'pass', mc_p)    # 开启后按 dur=1.2 s 取窗，吃进 0.8 s 后的响亮配乐
        self.assertLess(mc_p['evidence']['items'][0]['bestBandSnrDb'], mc['evidence']['items'][0]['bestBandSnrDb'])
        self.assertTrue(QA._resolve_film_flag({'audio': {'qa': {'preciseWindow': True}}}, None, 'preciseWindow'))
        self.assertFalse(QA._resolve_film_flag({'audio': {}}, None, 'preciseWindow'))

    def test_inline_film_json_foreground_events_are_audited(self):
        # 只在 film.json 顶层写 foregroundEvents（没有 events、没有 sidecar）也要出掩蔽检查，不能静默跳过
        fg = [{'id': 'fg1', 't': 0.5, 'dur': 0.2, 'audio': 'fg1', 'domain': 'sfx'}]
        wav, fdir = self._fx_music_film('mask-inline-fg', foregroundEvents=fg)
        mc = QA.check_masking(wav, fdir)
        self.assertIsNotNone(mc)
        self.assertEqual([it['id'] for it in mc['evidence']['items']], ['fg1'])


if __name__ == '__main__':
    unittest.main()
