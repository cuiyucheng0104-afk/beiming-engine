# -*- coding: utf-8 -*-
"""商用音效库索引与检索（engine/audio/sfx_library.py）测试：BOM CSV 解析、瑕疵清单标记、
目录字典化索引往返、中英检索与时长过滤、无库环境（CI）降级。全部离线，不碰 rog-5090。"""
import os
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
            self.assertEqual(sfx_library.abs_path('Lib/Sub A/ok_hit.wav'), '/mnt/sfx/Lib/Sub A/ok_hit.wav')

    def test_parse_defects_ignores_non_path_lines(self):
        d = sfx_library.parse_defects('## 0 字节空文件：1 个\n- 说明文字\nLib/x.wav\n噪声行\n')
        self.assertEqual(d, {'Lib/x.wav': 'zero_byte_deleted'})


if __name__ == '__main__':
    unittest.main()
