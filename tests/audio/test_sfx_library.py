# -*- coding: utf-8 -*-
"""商用音效库索引与检索（engine/audio/sfx_library.py）测试：BOM CSV 解析、瑕疵清单标记、
目录字典化索引往返、中英检索与时长过滤、无库环境（CI）降级。全部离线，不碰 rog-5090。"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from engine.audio import sfx_library  # noqa: E402

# 与 rog-5090 库根同构的最小 fixture：UTF-8 BOM、15 列、瑕疵清单两种缺陷
_CSV = (
    '品牌,子库,文件名,所在目录,格式,时长(秒),采样率,位深,声道,大小(MB),描述/关键词,分类,子分类,录制/设计者,描述来源\r\n'
    'TestBrand,Sub A,ok_hit.wav,Lib/Sub A,wav,1.50,48000,24,2,1.0,"water, splash, droplet",Water,,Tester,附带表格\r\n'
    'TestBrand,Sub A,renamed.wav,Lib/Sub A,wav,2.00,48000,24,2,1.0,"metal impact clang",Metal,,Tester,附带表格\r\n'
    'TestBrand,Sub A,renamed2.aif,Lib/Sub A,aif,2.50,48000,24,2,1.0,"metal clank ring",Metal,,Tester,附带表格\r\n'
    'TestBrand,Sub B,deleted.wav,Lib/Sub B,wav,3.00,48000,24,2,1.0,"footsteps wood",Foley,,Tester,附带表格\r\n'
)
_DEFECTS = (
    '# 音效库解压瑕疵清单（测试）\n\n'
    '## 扩展名 .wav 但文件头为 FORM（实为 AIFF）：2 个\n'
    'Lib/Sub A/renamed.wav\n'
    'Lib/Sub A/renamed2.wav\n\n'
    '## 0 字节空文件：1 个\n'
    'Lib/Sub B/deleted.wav\n\n'
    '## 处理记录（2026-11-24，主人确认）\n'
    '- 已处理\n'
)


def _build(tmp):
    csv_path = os.path.join(tmp, '总目录.csv')
    defects_path = os.path.join(tmp, '瑕疵清单.txt')
    with open(csv_path, 'wb') as f:
        f.write(b'\xef\xbb\xbf' + _CSV.encode('utf-8'))  # BOM：真实总目录带 BOM，解析必须剥掉
    with open(defects_path, 'w', encoding='utf-8') as f:
        f.write(_DEFECTS)
    return sfx_library.build_index(csv_path, defects_path)


class BuildIndexTests(unittest.TestCase):
    def test_bom_csv_and_defect_marks(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows, stats = _build(tmp)
            self.assertEqual(len(rows), 4)
            self.assertEqual(stats['renamed'], 2)
            self.assertEqual(stats['deleted'], 1)
            by_file = {r['file']: r for r in rows}
            # 修复前导出的 CSV（行还是 .wav）与修复后导出的 CSV（行已是 .aif）都要对上清单
            self.assertEqual(by_file['renamed.wav']['defect'], 'aiff_renamed_from_wav')
            self.assertEqual(by_file['renamed2.aif']['defect'], 'aiff_renamed_from_wav')
            self.assertEqual(by_file['renamed2.aif']['dir'], 'Lib/Sub A')
            self.assertEqual(by_file['deleted.wav']['defect'], 'zero_byte_deleted')
            self.assertNotIn('defect', by_file['ok_hit.wav'])
            self.assertEqual(by_file['ok_hit.wav']['dur'], 1.5)

    def test_index_roundtrip_restores_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows, _ = _build(tmp)
            out = os.path.join(tmp, 'index.jsonl')
            size = sfx_library.write_index(rows, out)
            self.assertGreater(size, 0)
            loaded = sfx_library.load_index(out)
            self.assertEqual([r['file'] for r in loaded], [r['file'] for r in rows])
            self.assertTrue(all('dir' in r for r in loaded))
            self.assertEqual(loaded[0]['dir'], 'Lib/Sub A')
            self.assertEqual(loaded[0]['desc'], 'water, splash, droplet')


_HEADER = _CSV.split('\r\n')[0] + '\r\n'


def _write_csv(tmp, body, header=_HEADER):
    path = os.path.join(tmp, 'bad.csv')
    with open(path, 'wb') as f:
        f.write(b'\xef\xbb\xbf' + (header + body).encode('utf-8'))
    return path


class BuildIndexErrorTests(unittest.TestCase):
    def test_missing_column_names_the_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_csv(tmp, 'B,S,a.wav,D,wav,1.0,48000,24,2,1,x,c,,t,t\r\n',
                              header=_HEADER.replace('时长(秒)', '长度'))
            with self.assertRaises(sfx_library.IndexBuildError) as cm:
                sfx_library.build_index(path)
            self.assertIn('时长(秒)', str(cm.exception))

    def test_bad_duration_reports_line_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_csv(tmp, 'B,S,ok.wav,D,wav,1.0,48000,24,2,1,x,c,,t,t\r\n'
                                   'B,S,bad.wav,D,wav,abc,48000,24,2,1,x,c,,t,t\r\n')
            with self.assertRaises(sfx_library.IndexBuildError) as cm:
                sfx_library.build_index(path)
            msg = str(cm.exception)
            self.assertIn('第 3 行', msg)  # 表头是第 1 行
            self.assertIn('bad.wav', msg)

    def test_negative_nan_and_short_rows_rejected(self):
        for body, needle in (('B,S,n.wav,D,wav,-1,48000,24,2,1,x,c,,t,t\r\n', '负数'),
                             ('B,S,n.wav,D,wav,nan,48000,24,2,1,x,c,,t,t\r\n', '有限'),
                             ('B,S,n.wav,D,wav,1.0\r\n', '采样率')):
            with tempfile.TemporaryDirectory() as tmp:
                path = _write_csv(tmp, body)
                try:
                    rows, _ = sfx_library.build_index(path)
                except sfx_library.IndexBuildError as e:
                    self.assertIn(needle, str(e), body)
                else:  # 短行只缺数值列时按空值 0 处理不算坏数据，其余必须报错
                    self.assertEqual(needle, '采样率')
                    self.assertEqual(rows[0]['sr'], 0)


class RightsFieldTests(unittest.TestCase):
    def test_residue_subs_annotated_but_all_owner_confirmed_and_searchable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_csv(tmp, 'B,SoundMorph.Portals,door.wav,D,wav,1.0,48000,24,2,1,door slam,Doors,,t,t\r\n'
                                   'B,Pro Sound Effects - First,d2.wav,D,wav,1.0,48000,24,2,1,door slam,Doors,,t,t\r\n'
                                   'B,SoundMorph.Energy,d3.wav,D,wav,1.0,48000,24,2,1,door slam,Doors,,t,t\r\n')
            rows, _ = sfx_library.build_index(path)
        by_sub = {r['sub']: r for r in rows}
        self.assertEqual(by_sub['SoundMorph.Portals']['source_residue'], sfx_library.RESIDUE_TAG)
        self.assertNotIn('source_residue', by_sub['Pro Sound Effects - First'])
        self.assertNotIn('source_residue', by_sub['SoundMorph.Energy'])
        hits = sfx_library.search('door', index=rows)
        self.assertEqual(len(hits), 3)  # 注记不排除
        self.assertEqual({h['rights'] for h in hits}, {'owner-confirmed'})
        portals = [h for h in hits if h['sub'] == 'SoundMorph.Portals'][0]
        self.assertTrue(portals['residue_files'])

    def test_committed_index_marks_residue_subs(self):
        rows = sfx_library.load_index()
        flagged = {r['sub'] for r in rows if r.get('source_residue')}
        self.assertEqual(flagged, set(sfx_library.SOURCE_RESIDUE))
        self.assertFalse([r for r in rows if r['sub'] in sfx_library.SOURCE_RESIDUE and not r.get('source_residue')])


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.index, _ = _build(cls._tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_english_query_ranks_filename_and_desc(self):
        hits = sfx_library.search('water splash', index=self.index)
        self.assertEqual(hits[0]['file'], 'ok_hit.wav')
        self.assertTrue(hits[0]['path'].startswith('Lib/Sub A/'))

    def test_chinese_query_expands_via_ucs_vocab(self):
        # 「水花」经 UCS 词表翻成 water/splash 类英文词，不必依赖库内中文描述
        hits = sfx_library.search('水', index=self.index)
        self.assertEqual(hits[0]['file'], 'ok_hit.wav')

    def test_defective_rows_excluded_by_default(self):
        hits = sfx_library.search('metal', index=self.index)
        self.assertEqual(hits, [])  # metal 命中全是改名文件，默认排除
        hits = sfx_library.search('metal', index=self.index, include_defective=True)
        self.assertEqual({h['file'] for h in hits}, {'renamed.wav', 'renamed2.aif'})

    def test_filters_and_duration_range(self):
        self.assertEqual(sfx_library.search(index=self.index, sub='Sub B', include_defective=True)[0]['file'], 'deleted.wav')
        self.assertEqual(sfx_library.search('footsteps', index=self.index, dur_max=1.0, include_defective=True), [])
        self.assertEqual(sfx_library.search('footsteps', index=self.index, dur_min=2.5, include_defective=True)[0]['file'], 'deleted.wav')
        self.assertEqual(sfx_library.search('footsteps', index=self.index, brand='Other'), [])


class EnvironmentTests(unittest.TestCase):
    def test_committed_index_offline_and_ci_degradation(self):
        # 仓库内置索引随仓库分发：检索离线可跑，CI 不需要 /mnt/data1
        self.assertTrue(sfx_library.available())
        self.assertGreater(len(sfx_library.search('water', limit=5)), 0)
        env = {k: v for k, v in os.environ.items() if k != sfx_library.ENV_ROOT}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(sfx_library.root())
            self.assertIsNone(sfx_library.abs_path('Lib/Sub A/ok_hit.wav'))
        with mock.patch.dict(os.environ, {sfx_library.ENV_ROOT: '/mnt/sfx'}):
            self.assertEqual(sfx_library.abs_path('Lib/Sub A/ok_hit.wav'), os.path.join('/mnt/sfx', 'Lib/Sub A/ok_hit.wav'))  # Windows 上 os.path.join 用反斜杠

    def test_parse_defects_ignores_non_path_lines(self):
        d = sfx_library.parse_defects('## 0 字节空文件：1 个\n- 说明文字\nLib/x.wav\n噪声行\n')
        self.assertEqual(d, {'Lib/x.wav': 'zero_byte_deleted'})


_TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tools', 'sfx_library.py')


def _cli(*argv):
    return subprocess.run([sys.executable, _TOOL, *argv], capture_output=True, text=True, encoding='utf-8')


class CliTests(unittest.TestCase):
    def test_search_with_custom_index_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows, _ = _build(tmp)
            idx = os.path.join(tmp, 'index.jsonl')
            sfx_library.write_index(rows, idx)
            r = _cli('search', 'water', '--index', idx, '--json')
            self.assertEqual(r.returncode, 0, r.stderr)
            hits = json.loads(r.stdout)['data']['hits']
            self.assertEqual([h['file'] for h in hits], ['ok_hit.wav'])  # 用的是 fixture 索引而不是内置索引

    def test_search_missing_index_is_environment_error(self):
        r = _cli('search', 'water', '--index', os.path.join(tempfile.gettempdir(), 'no-such-sfx-index.jsonl'))
        self.assertEqual(r.returncode, 3, r.stderr)

    def test_index_bad_csv_is_contract_error_with_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_csv(tmp, 'B,S,bad.wav,D,wav,abc,48000,24,2,1,x,c,,t,t\r\n')
            r = _cli('index', '--csv', path, '--out', os.path.join(tmp, 'o.jsonl'))
            self.assertEqual(r.returncode, 4, r.stderr)
            self.assertIn('第 2 行', r.stderr + r.stdout)

    def test_search_output_marks_residue_sub(self):
        r = _cli('search', 'door', '--sub', 'SoundMorph.Portals', '--limit', '3')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('来源注记:third-party-files', r.stdout)


class CatalogV2Tests(unittest.TestCase):
    """Step 1 方案 B：结构化增强（id/role/norm_cat/vgroup）、总地图 manifest、FTS5 检索、gid 回填、按需拉取与音频加载。"""

    def _sample_rows(self):
        return [
            {
                'brand': 'BOOM Library', 'sub': 'Mechanicals Designed',
                'file': 'mech_click_01.wav', 'dir': 'SoundMorph/Mechanicals Designed',
                'dur': 1.2, 'sr': 96000, 'bits': 24, 'ch': 2,
                'desc': 'METAL MECHANISM click snap lock', 'cat': 'Engineering', 'subcat': 'Mechanisms',
            },
            {
                'brand': 'BOOM Library', 'sub': 'Mechanicals Designed',
                'file': 'mech_click_02.wav', 'dir': 'SoundMorph/Mechanicals Designed',
                'dur': 1.3, 'sr': 96000, 'bits': 24, 'ch': 2,
                'desc': 'METAL MECHANISM click snap lock', 'cat': 'Engineering', 'subcat': 'Mechanisms',
            },
            {
                'brand': 'Pro Sound Effects', 'sub': 'Pro.Sound.Effects.Shanghai',
                'file': 'Waitan_AMB_Stereo.wav', 'dir': 'Pro.Sound.Effects.Shanghai/Part-01',
                'dur': 120.0, 'sr': 96000, 'bits': 24, 'ch': 2,
                'desc': 'Shanghai riverside crowd ambience traffic', 'cat': 'Ambience', 'subcat': 'City',
            },
            {
                'brand': 'SoundMorph', 'sub': 'SoundMorph.Energy',
                'file': 'energy_whoosh_passby_01.wav', 'dir': 'SoundMorph/SoundMorph.Energy/Whoosh',
                'dur': 2.4, 'sr': 96000, 'bits': 24, 'ch': 2,
                'desc': 'fast energy whoosh passby transition', 'cat': 'Whoosh and Passby', 'subcat': '',
            },
        ]

    def test_enrichment_fields_and_variant_grouping(self):
        rows = self._sample_rows()
        enriched = [sfx_library.enrich_row(r) for r in rows]
        # 稳定短 ID（同路径同 ID）
        self.assertTrue(all(r['id'] for r in enriched))
        self.assertEqual(enriched[0]['id'], sfx_library.stable_id('SoundMorph/Mechanicals Designed/mech_click_01.wav'))
        self.assertNotEqual(enriched[0]['id'], enriched[1]['id'])
        # role 与 norm_cat
        self.assertEqual(enriched[0]['role'], 'oneshot')
        self.assertEqual(enriched[0]['norm_cat'], 'mechanical')
        self.assertEqual(enriched[2]['role'], 'bed')
        self.assertEqual(enriched[2]['norm_cat'], 'ambience')
        self.assertEqual(enriched[3]['role'], 'transition')
        # 变体组名去掉尾部 _01 / _02
        self.assertEqual(enriched[0]['vgroup'], enriched[1]['vgroup'])
        # group_variants=True 合并同类变体
        grouped = sfx_library.search('metal click', index=rows, group_variants=True)
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]['variant_count'], 2)
        self.assertEqual(len(grouped[0]['variants']), 2)
        # role / norm_cat 过滤
        beds = sfx_library.search(index=rows, role='bed')
        self.assertEqual([h['file'] for h in beds], ['Waitan_AMB_Stereo.wav'])
        mechs = sfx_library.search(index=rows, norm_cat='mechanical')
        self.assertEqual(len(mechs), 2)

    def test_manifest_build_and_committed_manifest(self):
        rows = self._sample_rows()
        m = sfx_library.build_manifest(rows)
        self.assertEqual(m['schema'], 'beiming.sfx-manifest/1')
        self.assertEqual(m['stats']['total'], 4)
        self.assertIn('gdrive', m['source']['provider'])
        self.assertIn('mechanical', m['categories'])
        self.assertIn('ambience', m['categories'])
        self.assertIn('oneshot', m['roles'])
        # 仓库内置总地图存在且不含内网 IP / 本机路径
        self.assertTrue(sfx_library.MANIFEST_PATH.exists())
        cm = sfx_library.load_manifest()
        raw = json.dumps(cm, ensure_ascii=False)
        self.assertNotIn('192.168.', raw)
        self.assertNotIn('/Users/', raw)
        self.assertEqual(cm['stats']['total'], 15784)

    def test_fts5_cache_search_and_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx = os.path.join(tmp, 'index.jsonl')
            cache_dir = os.path.join(tmp, 'cache')
            sfx_library.write_index(self._sample_rows(), idx)
            hits = sfx_library.search('metal click', index_path=idx, cache_dir=cache_dir)
            self.assertEqual(len(hits), 2)
            self.assertTrue(os.path.exists(os.path.join(cache_dir, 'index.sqlite')))
            # 第二次命中已有 sqlite 缓存
            hits2 = sfx_library.search('shanghai ambience', index_path=idx, cache_dir=cache_dir, role='bed')
            self.assertEqual([h['file'] for h in hits2], ['Waitan_AMB_Stereo.wav'])

    def test_info_and_backfill_gids_roundtrip(self):
        rows = self._sample_rows()
        lsjson = [
            {'Path': 'SoundMorph/Mechanicals Designed/mech_click_01.wav', 'ID': '1AbCdEfGhIjKlMnOpQrStUvWxYz', 'IsDir': False},
            {'Path': '/Pro.Sound.Effects.Shanghai/Part-01/Waitan_AMB_Stereo.wav', 'ID': '2ZyXwVuTsRqPoNmLkJiHgFeDcBa', 'IsDir': False},
            {'Path': 'SoundMorph/Mechanicals Designed', 'ID': 'dir-ignored', 'IsDir': True},
        ]
        updated, stats = sfx_library.backfill_gids(rows, lsjson)
        self.assertEqual(stats['matched'], 2)
        self.assertEqual(stats['total'], 4)
        with tempfile.TemporaryDirectory() as tmp:
            idx = os.path.join(tmp, 'index.jsonl')
            sfx_library.write_index(updated, idx)
            reloaded = sfx_library.load_index(idx)
            target_id = sfx_library.stable_id('SoundMorph/Mechanicals Designed/mech_click_01.wav')
            item = sfx_library.info(target_id, index=reloaded)
            self.assertEqual(item['gid'], '1AbCdEfGhIjKlMnOpQrStUvWxYz')
            self.assertEqual(len(item['variants']), 2)

    def test_fetch_on_demand_cache_and_path_traversal_guard(self):
        rows = self._sample_rows()
        rows[0]['gid'] = 'fake-gdrive-id-001'
        target_id = sfx_library.stable_id('SoundMorph/Mechanicals Designed/mech_click_01.wav')
        calls = []

        def fake_downloader(entry, dest_path):
            calls.append((entry['gid'], dest_path))
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with open(dest_path, 'wb') as f:
                f.write(b'RIFFdemo')

        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k not in (sfx_library.ENV_ROOT, sfx_library.ENV_REMOTE)}
            with mock.patch.dict(os.environ, env, clear=True):
                p1 = sfx_library.fetch(target_id, index=rows, cache_dir=tmp, downloader=fake_downloader)
                p2 = sfx_library.fetch(target_id, index=rows, cache_dir=tmp, downloader=fake_downloader)
                self.assertEqual(p1, p2)
                self.assertEqual(len(calls), 1)  # 第二次走本地缓存，不重复下载
                # 无 gid 且无 remote 必须明确报错，不静默吞掉
                with self.assertRaises(sfx_library.SfxFetchError):
                    sfx_library.fetch('SoundMorph/Mechanicals Designed/mech_click_02.wav', index=rows, cache_dir=tmp)
                # 路径穿越防护
                with self.assertRaises(sfx_library.SfxFetchError):
                    sfx_library.resolve('../etc/passwd', index=rows, cache_dir=tmp)
                # 拼错的短 ID 应明确报索引找不到，而不是误当相对路径
                with self.assertRaises(sfx_library.SfxFetchError) as cm_id:
                    sfx_library.resolve('sfx_0000000000', index=rows, cache_dir=tmp)
                self.assertIn('找不到短 ID', str(cm_id.exception))
                # 直链下载遇到网络异常应转为 SfxFetchError（不抛裸 OSError）
                with mock.patch('shutil.which', return_value=None), \
                     mock.patch('urllib.request.urlopen', side_effect=OSError('network down')):
                    rows[1]['gid'] = 'fake-gid-net-err'
                    with self.assertRaises(sfx_library.SfxFetchError) as cm_net:
                        sfx_library.fetch('SoundMorph/Mechanicals Designed/mech_click_02.wav', index=rows, cache_dir=tmp)
                    self.assertIn('network down', str(cm_net.exception))

    def test_load_audio_one_shot_and_bed_deterministic(self):
        try:
            import numpy as np
            import soundfile as sf
        except ImportError:
            self.skipTest('numpy/soundfile unavailable')
        rows = self._sample_rows()
        with tempfile.TemporaryDirectory() as tmp:
            # 写一个 24kHz 单声道短 WAV，验证重采样到 48kHz 立体声 float64
            rel_dir = os.path.join(tmp, 'SoundMorph', 'Mechanicals Designed')
            os.makedirs(rel_dir, exist_ok=True)
            t = np.arange(24000, dtype=np.float32) / 24000.0
            sig = 0.25 * np.sin(2 * np.pi * 440.0 * t)
            sf.write(os.path.join(rel_dir, 'mech_click_01.wav'), sig, 24000)
            sf.write(os.path.join(rel_dir, 'mech_click_02.wav'), sig * 0.8, 24000)
            with mock.patch.dict(os.environ, {sfx_library.ENV_ROOT: tmp}):
                x = sfx_library.load_audio('SoundMorph/Mechanicals Designed/mech_click_01.wav', index=rows)
                self.assertEqual(x.dtype, np.float64)
                self.assertEqual(x.ndim, 2)
                self.assertEqual(x.shape[1], 2)
                self.assertAlmostEqual(len(x) / 48000.0, 1.0, places=2)
                # one_shot 确定性
                pool = ['SoundMorph/Mechanicals Designed/mech_click_01.wav', 'SoundMorph/Mechanicals Designed/mech_click_02.wav']
                a1 = sfx_library.one_shot(pool, seed=99, index=rows)
                a2 = sfx_library.one_shot(pool, seed=99, index=rows)
                self.assertTrue(np.array_equal(a1, a2))
                # bed 无缝循环到精确长度 2.5s
                b = sfx_library.bed('SoundMorph/Mechanicals Designed/mech_click_01.wav', dur=2.5, seed=7, xfade=0.1, index=rows)
                self.assertEqual(b.shape, (int(round(2.5 * 48000)), 2))

    def test_cli_manifest_info_and_backfill(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx = os.path.join(tmp, 'index.jsonl')
            man = os.path.join(tmp, 'manifest.json')
            lsj = os.path.join(tmp, 'lsjson.json')
            sfx_library.write_index(self._sample_rows(), idx)
            with open(lsj, 'w', encoding='utf-8') as f:
                json.dump([{'Path': 'SoundMorph/Mechanicals Designed/mech_click_01.wav', 'ID': 'gid-xyz', 'IsDir': False}], f)
            r = _cli('backfill-gids', '--lsjson', lsj, '--index', idx, '--out', idx, '--manifest', man, '--folder-id', 'folder-123', '--json')
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)['data']
            self.assertEqual(data['matched'], 1)
            r2 = _cli('manifest', '--manifest', man, '--json')
            self.assertEqual(r2.returncode, 0, r2.stderr)
            self.assertEqual(json.loads(r2.stdout)['data']['source']['folder_id'], 'folder-123')
            tid = sfx_library.stable_id('SoundMorph/Mechanicals Designed/mech_click_01.wav')
            r3 = _cli('info', tid, '--index', idx, '--json')
            self.assertEqual(r3.returncode, 0, r3.stderr)
            self.assertEqual(json.loads(r3.stdout)['data']['gid'], 'gid-xyz')


if __name__ == '__main__':
    unittest.main()
