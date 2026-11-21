# -*- coding: utf-8 -*-
"""画面自动打点与空间轨迹提取器 engine/audio/spotting.py 单元测试（含 FFmpeg 合成 MP4 实测）。"""
import json
import os
import shutil
import time
import unittest

import numpy as np

import _audiotest as H
from engine.audio import _env
from engine.audio import cues as C
from engine.audio import dsp as D
from engine.audio import editorial as ED
from engine.audio import spotting as SP


class AudioSpottingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('audio-spotting')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_spot_from_kinematics_cuts_shots_holds_and_motion_peaks(self):
        """spot_from_kinematics：准确识别切点、分割镜头统计、提取 ≥0.25s 留白段，并剔除切点 ±1 帧伪运动峰。"""
        fps = 24.0
        n_frames = 96  # 4.0s
        dur = n_frames / fps

        luma = [0.20 if f < 48 else 0.72 for f in range(n_frames)]
        motion = [0.04] * n_frames
        pan_x = [0.0] * n_frames
        cut = [0] * n_frames
        hold = [0] * n_frames

        # 第 48 帧 (2.0s) 硬切；故意在 47/48/49 放高值验证切点 ±1 帧排除规则
        cut[48] = 1
        motion[47] = 0.85
        motion[48] = 0.95
        motion[49] = 0.80

        # 镜头 1 静态呼吸留白：帧 4..14 (10 帧 ≈ 0.417s ≥ 0.25s)；另加一个仅 3 帧 (0.125s < 0.25s) 的短停顿应被过滤
        for f in range(4, 14):
            hold[f] = 1
            motion[f] = 0.005
        for f in range(36, 39):
            hold[f] = 1

        # 两个真实动作重音峰：帧 24 (1.0s，前导帧 22 有个小抖动 0.22，主峰 24 为 0.68 应胜出) 与帧 72 (3.0s，右侧 +0.65)
        motion[22] = 0.22
        motion[24] = 0.68
        pan_x[24] = -0.55

        motion[72] = 0.52
        pan_x[72] = 0.65

        raw = {
            'fps': fps,
            'dur': dur,
            'detectedCuts': [48],
            'tracks': {
                'screen': {
                    'luma': luma,
                    'contrast': [0.35] * n_frames,
                    'motion': motion,
                    'x': pan_x,
                    'cut': cut,
                    'hold': hold,
                },
            },
        }

        # 同时验证 dict、JSON 文件路径与 Kinematics 实例三种输入结果完全一致
        kin_path = os.path.join(self.td, 'kinematics.json')
        with open(kin_path, 'w', encoding='utf-8') as f:
            json.dump(raw, f)

        rep_dict = SP.spot_from_kinematics(raw, prominence=0.16, min_gap_s=0.15)
        rep_path = SP.spot_from_kinematics(kin_path, prominence=0.16, min_gap_s=0.15)
        rep_dir = SP.spot_from_kinematics(self.td, prominence=0.16, min_gap_s=0.15)
        rep_obj = SP.spot_from_kinematics(C.load_kinematics(kin_path), prominence=0.16, min_gap_s=0.15)
        self.assertEqual(rep_dict, rep_path)
        self.assertEqual(rep_dict, rep_dir)
        self.assertEqual(rep_dict, rep_obj)

        self.assertEqual(rep_dict['cuts'], [{'frame': 48, 't': 2.0}])
        self.assertEqual(len(rep_dict['shots']), 2)
        self.assertEqual(rep_dict['shots'][0]['index'], 0)
        self.assertAlmostEqual(rep_dict['shots'][0]['t0'], 0.0, places=5)
        self.assertAlmostEqual(rep_dict['shots'][0]['t1'], 2.0, places=5)
        self.assertAlmostEqual(rep_dict['shots'][0]['mean_luma'], 0.20, places=3)
        self.assertAlmostEqual(rep_dict['shots'][1]['t0'], 2.0, places=5)
        self.assertAlmostEqual(rep_dict['shots'][1]['t1'], 4.0, places=5)
        self.assertAlmostEqual(rep_dict['shots'][1]['mean_luma'], 0.72, places=3)

        # 只保留 ≥ 0.25s 的留白段 (4/24 .. 14/24)
        self.assertEqual(len(rep_dict['holds']), 1)
        self.assertAlmostEqual(rep_dict['holds'][0][0], round(4 / 24.0, 6), places=5)
        self.assertAlmostEqual(rep_dict['holds'][0][1], round(14 / 24.0, 6), places=5)

        # 动作重音峰：帧 47/48/49 被切点规则剔除，帧 22 被 0.15s 窗内更强的帧 24 压制
        peak_frames = [p['frame'] for p in rep_dict['motion_peaks']]
        self.assertEqual(peak_frames, [24, 72])
        self.assertAlmostEqual(rep_dict['motion_peaks'][0]['pan'], -0.55, places=3)
        self.assertAlmostEqual(rep_dict['motion_peaks'][1]['pan'], 0.65, places=3)

    def test_spot_from_kinematics_multispan_actors_and_editorial_coupling(self):
        """多段可见角色轨迹提取（spans / pan_points / screen_ratio / 径向速度 / impulses）并无缝接入 couple_motion_trajectory。"""
        fps = 24.0
        n_frames = 96  # 4.0s
        dur = n_frames / fps

        # 角色 blade：两段可见区间 [6..42) (0.25s..1.75s) 与 [54..90) (2.25s..3.75s)，外加第 2 帧单帧闪烁噪点（应被 min_visible_frames=2 滤除）
        vis = [0] * n_frames
        vis[2] = 1
        x_ch = [0.0] * n_frames
        scale_ch = [0.08] * n_frames
        depth_ch = [8.0] * n_frames
        impact_ch = [0.0] * n_frames

        # 第一段：从左 (-0.85) 飞向中心 (-0.10)，由远及近逼近相机（depth 6.0m → 1.5m，scale 0.10 → 0.48）
        seg1_len = 42 - 6
        for k, f in enumerate(range(6, 42)):
            u = k / float(seg1_len - 1)
            vis[f] = 1
            x_ch[f] = -0.85 + 0.75 * u
            scale_ch[f] = 0.10 + 0.38 * u
            depth_ch[f] = 6.0 - 4.5 * u
        impact_ch[20] = 0.88
        impact_ch[1] = 0.95  # 不可见帧上的伪碰撞应被忽略

        # 第二段：从中心偏右 (+0.15) 飞向右侧 (+0.85)，继续保持近景
        seg2_len = 90 - 54
        for k, f in enumerate(range(54, 90)):
            u = k / float(seg2_len - 1)
            vis[f] = 1
            x_ch[f] = 0.15 + 0.70 * u
            scale_ch[f] = 0.48 + 0.12 * u
            depth_ch[f] = 1.5 - 0.3 * u
        impact_ch[72] = 0.76

        # 角色 receding_orb：单段远离相机（depth 1.2m → 9.0m，径向速度应为负值）
        orb_x = [0.30 + 0.40 * (f / float(n_frames - 1)) for f in range(n_frames)]
        orb_depth = [1.2 + 7.8 * (f / float(n_frames - 1)) for f in range(n_frames)]

        kin = C.Kinematics({
            'fps': fps,
            'dur': dur,
            'tracks': {
                'screen': {'luma': [0.3] * n_frames, 'motion': [0.1] * n_frames, 'cut': [0] * n_frames, 'hold': [0] * n_frames},
                'blade': {'x': x_ch, 'scale': scale_ch, 'depth': depth_ch, 'visible': vis, 'impact': impact_ch},
                'receding_orb': {'x': orb_x, 'depth': orb_depth},
            },
        })

        rep = SP.spot_from_kinematics(kin, min_visible_frames=2)
        blade = rep['actors']['blade']
        self.assertEqual(blade['spans'], [(0.25, 1.75), (2.25, 3.75)])
        self.assertEqual(len(blade['segments']), 2)
        self.assertAlmostEqual(blade['peak_scale'], 0.60, places=3)
        self.assertGreater(blade['radial_velocity_mps'], 1.5, '逼近镜头的角色径向速度应显著大于 0')
        self.assertEqual(blade['impulses'], [(round(20 / 24.0, 6), 0.88), (3.0, 0.76)])

        # 验证右侧半屏运动（+0.30 → +0.70）不会被误判为 [0..1] 翻转到左声道，且远离镜头速度为负
        orb = rep['actors']['receding_orb']
        self.assertGreater(orb['mean_pan'], 0.40)
        self.assertLess(orb['radial_velocity_mps'], -1.5)

        # 直接把提取出的 pan_points / screen_ratio / radial_velocity_mps 送入 editorial.couple_motion_trajectory
        r = D.rng(101)
        whoosh_mono = D.bp(D.pink(D.N(2.0), r), 350.0, 4800.0, 2) * 0.45
        coupled = ED.couple_motion_trajectory(
            whoosh_mono,
            dur=2.0,
            pan_keyframes=blade['pan_points'],
            screen_ratio=blade['screen_ratio'],
            max_speed_mps=abs(blade['radial_velocity_mps']),
            shot_scale='full',
            poa='open_sky',
        )
        self.assertEqual(coupled.shape, (D.N(2.0), 2))

        # 开头（左远，scale=0.10, pan=-0.85）左声道强于右声道，结尾（右近，scale=0.60, pan=+0.85）右声道强于左声道且总能量显著抬升
        head = coupled[D.N(0.08):D.N(0.45)]
        tail = coupled[D.N(1.55):D.N(1.92)]
        self.assertGreater(D.rms(head[:, 0]), D.rms(head[:, 1]) * 1.6)
        self.assertGreater(D.rms(tail[:, 1]), D.rms(tail[:, 0]) * 1.6)
        self.assertGreater(D.rms(tail), D.rms(head) * 1.8)

    @unittest.skipUnless(H.which_ffmpeg(), '需要 ffmpeg 与 ffprobe')
    def test_spot_from_video_detects_hard_cut_and_left_to_right_pan_trajectory(self):
        """spot_from_video：对 FFmpeg 合成的测试 MP4（亮色滑块从左向右横穿一次硬切）精准检出切点帧与左→右声像轨迹。"""
        mp4_path = os.path.join(self.td, 'synthetic_flyby_cut.mp4')
        # 2.0s @ 24fps = 48 帧（640x360）：
        # · 镜头 1（帧 0..23，t < 1.0s）：深暗背景 (0x12161c)，亮白方块从左边缘匀速飞向画面中线；
        # · 镜头 2（帧 24..47，t >= 1.0s）：硬切至中高亮灰底板 + 顶部亮带（全画幅跳变），深色滑块继续从中线飞向最右侧！
        fc = (
            "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0x8c949e@1:t=fill:enable='gte(n,24)',"
            "drawbox=x=0:y=0:w=iw:h=64:color=0xd8dee9@1:t=fill:enable='gte(n,24)'[bg];"
            "[bg][1:v]overlay=x='20+11.5*n':y=130:enable='lt(n,24)'[v1];"
            "[v1][2:v]overlay=x='20+11.5*n':y=130:enable='gte(n,24)'[vout]"
        )
        gen = _env.run([
            _env.ffmpeg(), '-y', '-v', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x12161c:s=640x360:r=24:d=2.0',
            '-f', 'lavfi', '-i', 'color=c=white:s=72x100:r=24:d=2.0',
            '-f', 'lavfi', '-i', 'color=c=0x0b0d10:s=72x100:r=24:d=2.0',
            '-filter_complex', fc, '-map', '[vout]',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16',
            mp4_path,
        ], capture_output=True, timeout=30)
        self.assertEqual(gen.returncode, 0, (gen.stderr or b'').decode('utf-8', errors='replace'))

        t0 = time.monotonic()
        kin = SP.spot_from_video(mp4_path, sample_w=240, max_fps=30.0)
        elapsed_s = time.monotonic() - t0
        self.assertLess(elapsed_s, 1.5, f'spot_from_video 耗时应 < 1.5s，实测 {elapsed_s:.3f}s')

        self.assertIsInstance(kin, C.Kinematics)
        self.assertAlmostEqual(kin.fps, 24.0, places=2)
        self.assertAlmostEqual(kin.dur, 2.0, places=2)
        for tk in ('screen', 'left_zone', 'center_zone', 'right_zone'):
            self.assertIn(tk, kin.tracks)

        scr = kin['screen']
        cut_ch = scr.channels['cut']
        x_ch = scr.channels['x']
        luma_ch = scr.channels['luma']
        self.assertEqual(len(cut_ch), 48)

        # 精确检出第 24 帧硬切（允许编解码器 ±0 帧精确命中）
        cut_frames = [i for i, v in enumerate(cut_ch) if v > 0.5]
        self.assertEqual(cut_frames, [24])
        self.assertLess(float(np.mean(luma_ch[:24])), 0.20)
        self.assertGreater(float(np.mean(luma_ch[24:])), 0.45)

        # 左 → 右连续声像轨迹：前段显著偏左 (< -0.4)，末段显著偏右 (> +0.4)
        early_pan = float(np.mean(x_ch[2:12]))
        mid_pan = float(np.mean(x_ch[19:28]))
        late_pan = float(np.mean(x_ch[36:46]))
        self.assertLess(early_pan, -0.40, f'前段声像应 < -0.4，实测 {early_pan:.4f}')
        self.assertGreater(late_pan, 0.40, f'末段声像应 > +0.4，实测 {late_pan:.4f}')
        self.assertTrue(early_pan < mid_pan < late_pan)

        # 左/中/右三区活动度随滑块横移依次接力达到各自峰值
        lm = kin['left_zone'].channels['motion']
        cm = kin['center_zone'].channels['motion']
        rm = kin['right_zone'].channels['motion']
        self.assertGreater(float(np.mean(lm[2:14])), float(np.mean(rm[2:14])) * 3.0)
        self.assertGreater(float(np.mean(cm[16:31])), float(np.mean(lm[16:31])) * 1.5)
        self.assertGreater(float(np.mean(rm[34:47])), float(np.mean(lm[34:47])) * 3.0)

        # 验证 spot_from_video 输出可直接送入 spot_from_kinematics 做全链路自动打点
        spotted = SP.spot_from_kinematics(kin)
        self.assertEqual(spotted['cuts'], [{'frame': 24, 't': 1.0}])
        self.assertEqual(len(spotted['shots']), 2)
        self.assertIn('left_zone', spotted['actors'])
        self.assertIn('right_zone', spotted['actors'])

    @unittest.skipUnless(H.which_ffmpeg(), '需要 ffmpeg 与 ffprobe')
    def test_spot_from_video_20s_1080p_speed_holds_and_high_fps_cap(self):
        """spot_from_video：20 秒 1920x1080 视频流式分析耗时 < 1.5s，且支持静止留白段与 60fps 降采样上限。"""
        mp4_20s = os.path.join(self.td, 'bench_20s_1080p.mp4')
        # 20.0s @ 24fps 1920x1080：前 3s 完全静止（留白 hold），t=10.0s (第 240 帧) 硬切，后半段带运动块
        fc = (
            "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0x7c8590@1:t=fill:enable='gte(n,240)'[bg];"
            "[bg][1:v]overlay=x='120+6*(n-72)':y=420:enable='between(n,72,239)'[v1];"
            "[v1][1:v]overlay=x='200+5*(n-240)':y=420:enable='gte(n,240)'[vout]"
        )
        gen = _env.run([
            _env.ffmpeg(), '-y', '-v', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x14181f:s=1920x1080:r=24:d=20.0',
            '-f', 'lavfi', '-i', 'color=c=white:s=180x220:r=24:d=20.0',
            '-filter_complex', fc, '-map', '[vout]',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '23',
            mp4_20s,
        ], capture_output=True, timeout=60)
        self.assertEqual(gen.returncode, 0, (gen.stderr or b'').decode('utf-8', errors='replace'))

        t0 = time.monotonic()
        kin_20s = SP.spot_from_video(mp4_20s, sample_w=240, max_fps=30.0)
        dt = time.monotonic() - t0
        self.assertLess(dt, 1.5, f'20s 1080p 视频分析耗时应 < 1.5s，实测 {dt:.3f}s')

        spotted = SP.spot_from_kinematics(kin_20s)
        self.assertEqual(spotted['cuts'], [{'frame': 240, 't': 10.0}])
        self.assertTrue(any(h[0] <= 0.1 and h[1] >= 2.5 for h in spotted['holds']), f'应识别开头 3s 静止留白段，实测 {spotted["holds"]}')

        # 60fps 输入配合 max_fps=30.0 自动整比降采样到 30fps
        mp4_60 = os.path.join(self.td, 'high_60fps.mp4')
        gen60 = _env.run([
            _env.ffmpeg(), '-y', '-v', 'error',
            '-f', 'lavfi', '-i', 'color=c=0x1e2430:s=640x360:r=60:d=1.0',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            mp4_60,
        ], capture_output=True, timeout=30)
        self.assertEqual(gen60.returncode, 0)
        kin_60 = SP.spot_from_video(mp4_60, sample_w=160, max_fps=30.0)
        self.assertLessEqual(kin_60.fps, 30.0 + 1e-3)
        self.assertEqual(len(kin_60['screen'].channels['luma']), 30)


if __name__ == '__main__':
    unittest.main()
