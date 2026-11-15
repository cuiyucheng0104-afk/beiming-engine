# -*- coding: utf-8 -*-
"""Freesound 真实音效检索 tools/fetch_sfx.py 的人类投票重排与嘴模/合成器/内置麦描述过滤测试。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))
from tools.fetch_sfx import human_score, desc_signal  # noqa: E402


class FetchSfxRankTests(unittest.TestCase):
    def test_high_vote_count_beats_tiny_five_star_sample(self):
        # ★4.4(380) with 4500 downloads must beat ★5.0(2) with 12 downloads
        trusted = {'num_downloads': 4500, 'avg_rating': 4.4, 'num_ratings': 380,
                   'description': 'Recorded with Sennheiser MKH416 and Sound Devices 702 in foley studio.',
                   'tags': ['wood', 'hit', 'foley']}
        fluke = {'num_downloads': 12, 'avg_rating': 5.0, 'num_ratings': 2,
                 'description': 'A sound I made.',
                 'tags': ['wood', 'hit']}
        self.assertGreater(human_score(trusted), human_score(fluke))

    def test_description_rejects_mouth_synth_and_phone_mic(self):
        self.assertLess(desc_signal('Gong sound made with my mouth into built-in mic', ['gong']), 0)
        self.assertLess(desc_signal('Synthesized in Serum VST with white noise', ['whoosh']), 0)
        self.assertGreater(desc_signal('Close foley recording of bamboo wind chimes on Zoom H6', ['bamboo']), 0)


if __name__ == '__main__':
    unittest.main()
