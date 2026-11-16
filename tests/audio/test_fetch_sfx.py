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

    def test_samplerate_and_lossless_format_scoring(self):
        low_sr = {'num_downloads': 800, 'avg_rating': 4.6, 'num_ratings': 40, 'samplerate': 11025, 'type': 'wav',
                  'description': 'Old foley clip', 'tags': ['cloth']}
        lossless_48k = {'num_downloads': 500, 'avg_rating': 4.4, 'num_ratings': 30, 'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
                        'description': 'Cloth foley', 'tags': ['cloth']}
        lossy_44k = {'num_downloads': 500, 'avg_rating': 4.4, 'num_ratings': 30, 'samplerate': 44100, 'bitdepth': 16, 'type': 'mp3',
                     'description': 'Cloth foley', 'tags': ['cloth']}
        self.assertLess(human_score(low_sr), 0)
        self.assertGreater(human_score(lossless_48k), human_score(lossy_44k))

    def test_hitech_query_allows_clean_electronic_ui_tags_while_organic_rejects_them(self):
        hitech_item = {
            'num_downloads': 600, 'avg_rating': 4.5, 'num_ratings': 25, 'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
            'description': 'Clean hitech HUD telemetry beep and laser scanner pulse',
            'tags': ['hitech', 'electronic', 'ui', 'laser', 'futuristic'],
        }
        # 自然拟音查询拒绝 electronic/laser 标签，而 hitech/ui 查询放行并加分
        self.assertLess(human_score(hitech_item, query='bamboo wood hit'), 0)
        self.assertGreater(human_score(hitech_item, query='hitech ui beep'), 20.0)

        # 物理本体守卫：搜无源纯机械物件（ballpoint pen / watch）时一票否决混入电机/伺服嗡声的素材
        motor_polluted = {
            'name': 'Zoom Camera Servo Motor.wav', 'num_downloads': 2000, 'avg_rating': 4.7, 'num_ratings': 60,
            'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
            'description': 'Small electric motor and servo whir', 'tags': ['mechanical', 'servo'],
        }
        self.assertLess(human_score(motor_polluted, query='ballpoint pen click'), 0)


if __name__ == '__main__':
    unittest.main()
