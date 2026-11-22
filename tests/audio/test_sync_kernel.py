# -*- coding: utf-8 -*-
"""L3 纯 CPU 运动学对冲击同步核（engine/audio/sync_kernel.py）与 audio:qa 集成单元测试。"""
import json
import os
import shutil
import subprocess
import sys
import time
import unittest

import numpy as np

import _audiotest as H
from engine.audio import dsp as D
from engine.audio import qa as QA
from engine.audio import sync_kernel as SK


def _build_synthetic_sync_scene(dur_s: float = 10.0, fps: int = 24, sr: int = D.SR):
    """构造 10 s 确定性合成音画同步测试集：非均匀冲击帧点（含奇偶帧），含 actor 轨迹、screen.motion、灰度帧与对齐 sfx。"""
    n_frames = int(round(dur_s * fps))
    event_frames = [18, 37, 56, 79, 102, 125, 148, 171, 194, 217]

    x_pos = np.linspace(-0.4, 0.4, n_frames)
    y_pos = np.zeros(n_frames)
    scale = np.full(n_frames, 0.35)
    vis = np.ones(n_frames)
    scr_motion = np.full(n_frames, 0.002)
    frames_2d = np.full((n_frames, 24 * 32), 24.0, dtype=np.float64)

    r = np.random.default_rng(2026)
    sfx = np.zeros(int(round(dur_s * sr)), dtype=np.float64)
    level = 24.0
    for idx, f_idx in enumerate(event_frames):
        # 位置阶跃脉冲：加速度二阶差分 a2 在 f_idx 产生尖锐单帧峰
        x_pos[f_idx:] += 0.35 if (idx % 2 == 0) else -0.30
        y_pos[f_idx] += 0.28
        scr_motion[f_idx] = 1.0
        # 切换整帧亮度台阶，使一阶帧差 d1[f_idx] 精准在 f_idx 形成单帧峰
        level = 210.0 if level < 100.0 else 24.0
        frames_2d[f_idx:] = level

        t_s = f_idx / float(fps)
        s0 = int(round(t_s * sr))
        ln = int(round(0.055 * sr))
        tt = np.arange(ln) / float(sr)
        burst = D.bp(r.standard_normal(ln), 1200.0, 9500.0, 2) * np.minimum(1.0, tt / 0.0015) * np.exp(-tt / 0.012)
        end = min(len(sfx), s0 + ln)
        sfx[s0:end] += burst[:end - s0] * 0.7

    kin = {
        'fps': fps,
        'dur': dur_s,
        'tracks': {
            'hero': {
                'x': x_pos.tolist(),
                'y': y_pos.tolist(),
                'scale': scale.tolist(),
                'visible': vis.tolist(),
            },
            'screen': {
                'motion': scr_motion.tolist(),
            },
        },
    }
    return kin, frames_2d, sfx


def _shift_audio(x: np.ndarray, frames: float, fps: float = 24.0, sr: int = D.SR) -> np.ndarray:
    d = int(round(frames / fps * sr))
    y = np.zeros_like(x)
    if d > 0:
        y[d:] = x[:len(x) - d]
    elif d < 0:
        y[:len(x) + d] = x[-d:]
    else:
        y[:] = x
    return y


class SyncKernelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = H.tmpdir('sync-kernel')
        cls.kin, cls.frames, cls.sfx = _build_synthetic_sync_scene()
        cls.kin_path = os.path.join(cls.td, 'kinematics.json')
        with open(cls.kin_path, 'w', encoding='utf-8') as f:
            json.dump(cls.kin, f)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_24fps_accuracy_and_drift_sweep_across_actor_screen_and_video_curves(self):
        shifts = (0, 1, -1, 2, -2, 4, -4)
        d1, d2p = SK.video_motion_curves(self.frames)

        for mode_name, extra in (
            ('actor', {'kinematics': self.kin, 'motion_path': 'actor'}),
            ('screen.motion', {'kinematics': self.kin, 'motion_path': 'screen'}),
            ('video.d1', {'motion': d1}),
            ('video.d2p', {'motion': d2p}),
        ):
            with self.subTest(path=mode_name):
                errs = []
                for k in shifts:
                    sig = _shift_audio(self.sfx, k)
                    res = SK.evaluate_sync(sig, sr=D.SR, fps=24.0, fps_mode='24fps', input_track='sfx', **extra)
                    err = abs(res['offset_frames'] - k)
                    errs.append(err)
                    if k == 0:
                        self.assertEqual(res['status'], 'pass', res)
                        self.assertTrue(res['ok'])
                    if abs(k) >= 2:
                        self.assertEqual(res['status'], 'fail', f'{mode_name} k={k}: {res}')
                        self.assertFalse(res['ok'])
                self.assertLess(max(errs), 1.0, f'{mode_name} 最大误差超 1 帧: {errs}')

    def test_on_twos_12fps_guard_prevents_comb_jumps_and_supports_tight_warn(self):
        n_frames = len(self.frames)
        # 1) 构造 12 fps 偶相重复帧视频帧差（奇偶帧均有真实事件）
        fr12_even = np.repeat(self.frames[0::2], 2, axis=0)[:n_frames]
        fr12_odd = np.r_[self.frames[:1], np.repeat(self.frames[1::2], 2, axis=0)][:n_frames]
        d1_even, _ = SK.video_motion_curves(fr12_even)
        d1_odd, _ = SK.video_motion_curves(fr12_odd)

        # 未加守卫时 d1_even 仅偶帧非零（12 Hz 零值梳）
        _, detected_ev = SK.apply_on_twos_guard(d1_even, force=False)
        self.assertTrue(detected_ev)

        guarded_ev, _ = SK.apply_on_twos_guard(d1_even, force=True)
        guarded_od, _ = SK.apply_on_twos_guard(d1_odd, force=True)
        for label, m_g in (('even', guarded_ev), ('odd', guarded_od)):
            errs = []
            for k in (0, 1, -1, 2, -2, 4, -4):
                r = SK.estimate_offset_frames(m_g, _shift_audio(self.sfx, k), sr=D.SR, fps=24.0)
                errs.append(abs(r['offset_frames'] - k))
            self.assertLessEqual(max(errs), 1.0, f'12fps {label} 守卫后最大误差超 1 帧: {errs}')

        # 2) auto 自动识别一拍二角色轨迹，24 fps 不误判，12 fps 触发守卫并切到 12fps 口径
        self.assertFalse(SK.detect_actor_on_twos(self.kin))
        tr_24 = self.kin['tracks']['hero']
        kin12 = {
            'fps': 24,
            'dur': self.kin['dur'],
            'tracks': {
                'hero': {
                    k: np.repeat(np.asarray(v)[0::2], 2)[:n_frames].tolist()
                    for k, v in tr_24.items()
                }
            },
        }
        self.assertTrue(SK.detect_actor_on_twos(kin12))

        r_auto_24 = SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=self.kin, fps_mode='auto', input_track='sfx')
        self.assertEqual(r_auto_24['fps_mode'], '24fps')
        self.assertFalse(r_auto_24['on_twos_guard_applied'])

        r_auto_12 = SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=kin12, fps_mode='auto', input_track='sfx')
        self.assertEqual(r_auto_12['fps_mode'], '12fps')
        self.assertTrue(r_auto_12['on_twos_detected'])
        self.assertTrue(r_auto_12['on_twos_guard_applied'])
        self.assertEqual(r_auto_12['warn_threshold_frames'], SK.DRIFT_WARN_12FPS)
        self.assertEqual(r_auto_12['status'], 'pass', r_auto_12)

        # +2f 漂移在 12fps 偶相因 -0.5f 相移落在 ~+1.4f，1.1f 紧门限应能报警/拦截
        r_12_p2 = SK.evaluate_sync(_shift_audio(self.sfx, 2.0), sr=D.SR, kinematics=kin12, fps_mode='12fps', input_track='sfx')
        self.assertIn(r_12_p2['status'], ('warn', 'fail'), r_12_p2)

        # 全混音叠加 12fps 应显式提示周期配乐伪峰风险
        r_mix_12 = SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=kin12, fps_mode='12fps', input_track='mix')
        self.assertEqual(r_mix_12['input_track'], 'mix')
        self.assertTrue(any('全混音' in w and '伪峰' in w for w in r_mix_12['warnings']), r_mix_12['warnings'])

    def test_error_handling_silent_inputs_missing_ffmpeg_and_cpu_speed(self):
        # 1) 无遥测有音频但环境变量 FFMPEG 指向不存在路径 → 必须退出码 3（EXIT.ENV）
        sfx_wav = H.write_wav(os.path.join(self.td, 'sfx.wav'), np.column_stack([self.sfx, self.sfx]))
        fake_mp4 = os.path.join(self.td, 'dummy.mp4')
        with open(fake_mp4, 'wb') as f:
            f.write(b'not-a-real-mp4')

        r_noff = H.run(
            ['python', '-m', 'engine.audio.sync_kernel', '--audio', sfx_wav, '--video', fake_mp4, '--json'],
            FFMPEG='/nonexistent-ffmpeg-binary',
        )
        self.assertEqual(r_noff.returncode, 3, r_noff.stderr)
        env_noff = H.envelope(r_noff)
        self.assertEqual(env_noff['error']['code'], 'env.ffmpeg-missing')

        # 2) 缺失输入文件退出 3；参数冲突退出 2
        r_miss = H.run(['python', '-m', 'engine.audio.sync_kernel', '--audio', sfx_wav, '--kinematics', os.path.join(self.td, 'nope.json'), '--json'])
        self.assertEqual(r_miss.returncode, 3)
        r_conf = H.run(['python', '-m', 'engine.audio.sync_kernel', '--audio', sfx_wav, '--kinematics', self.kin_path, '--video', fake_mp4, '--json'])
        self.assertEqual(r_conf.returncode, 2)

        # 3) 全静音音频返回低置信度 warn，无 NaN/崩溃
        r_sil = SK.evaluate_sync(np.zeros_like(self.sfx), sr=D.SR, kinematics=self.kin, input_track='sfx')
        self.assertEqual(r_sil['status'], 'warn')
        self.assertFalse(r_sil['valid'])
        self.assertEqual(r_sil['peak_corr'], 0.0)

        # 4) 10 s 合成素材 actor 主路径纯 CPU 耗时应远低于 500 ms
        t0 = time.perf_counter()
        _ = SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=self.kin, input_track='sfx')
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertLess(elapsed_ms, 500.0, f'10s actor 同步核纯 CPU 耗时偏慢: {elapsed_ms:.1f} ms')

    @unittest.skipUnless(H.which_ffmpeg(), '需要系统安装 ffmpeg / ffprobe 测真实视频帧差退化路径')
    def test_video_fallback_path_with_real_mp4(self):
        # 生成 2.5 s 24 fps 闪烁合成 MP4 与对齐音频
        fps = 24
        dur = 2.5
        nf = int(round(dur * fps))
        w, h = 64, 48
        raw_path = os.path.join(self.td, 'syn.gray')
        mp4_path = os.path.join(self.td, 'syn.mp4')
        flash_frames = [8, 20, 34, 48]

        buf = np.full((nf, h, w), 20, dtype=np.uint8)
        sfx = np.zeros(int(round(dur * D.SR)), dtype=np.float64)
        r = np.random.default_rng(77)
        lvl = 20
        for fi in flash_frames:
            lvl = 225 if lvl < 100 else 20
            buf[fi:] = lvl
            s0 = int(round(fi / float(fps) * D.SR))
            ln = int(round(0.05 * D.SR))
            sfx[s0:s0 + ln] += D.bp(r.standard_normal(ln), 1200.0, 9000.0, 2) * np.exp(-np.arange(ln) / (D.SR * 0.01)) * 0.7
        with open(raw_path, 'wb') as f:
            f.write(buf.tobytes())

        from engine.audio import _env
        subprocess.run(
            [
                _env.ffmpeg(), '-y', '-v', 'error',
                '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', f'{w}x{h}', '-r', str(fps),
                '-i', raw_path, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4_path,
            ],
            check=True,
        )

        res_ok = SK.evaluate_sync(sfx, sr=D.SR, video_path=mp4_path, video_metric='d1', input_track='sfx')
        self.assertEqual(res_ok['path'], 'video.d1')
        self.assertEqual(res_ok['status'], 'pass', res_ok)
        self.assertLess(abs(res_ok['offset_frames']), 1.0)

        res_bad = SK.evaluate_sync(_shift_audio(sfx, 3.0, fps=fps), sr=D.SR, video_path=mp4_path, video_metric='d1', input_track='sfx')
        self.assertEqual(res_bad['status'], 'fail', res_bad)
        self.assertGreater(res_bad['offset_frames'], 2.0)

    def test_qa_cli_integration_and_backward_compatibility(self):
        # 搭一份 10 s 合规作品目录，比较传与不传 --kinematics 的 QA 行为与 Node CLI 同步选项一致性
        film_ok = os.path.join(self.td, 'film-sync-ok')
        H.film_json(film_ok, frames=240, fps=24, cuts=())
        bed = H.music_like(10.0, seed=9, lp_hz=1800) * 0.12
        sfx_st = np.column_stack([self.sfx, self.sfx]) * 0.65
        from engine.audio import mixing as MX
        mix_ok, g_db, _ = MX.loudness_to(D.fade(bed + sfx_st, 0.02, 0.05), -14.0, -1.5)
        mix_ok[0] = mix_ok[-1] = 0.0
        sc = 10.0 ** (g_db / 20.0)
        H.write_wav(os.path.join(film_ok, 'out', 'stems', 'sfx.wav'), sfx_st * sc)
        H.write_wav(os.path.join(film_ok, 'out', 'mix.wav'), mix_ok)

        # 1) 不传 --kinematics / --video：完全保持现有 QA 行为，不出 audio.sync
        r_legacy = H.run(['python', '-m', 'engine.audio.qa', '--film', film_ok, '--no-report', '--json'])
        self.assertEqual(r_legacy.returncode, 0, r_legacy.stderr)
        env_legacy = H.envelope(r_legacy)
        self.assertNotIn('audio.sync', {c['id'] for c in env_legacy['data']['checks']})

        # 2) 传 --kinematics：出现 audio.sync 且自动选用 stems/sfx.wav，通过并返回结构化字段
        r_sync_ok = H.run(['python', '-m', 'engine.audio.qa', '--film', film_ok, '--kinematics', self.kin_path, '--json'])
        self.assertEqual(r_sync_ok.returncode, 0, r_sync_ok.stderr)
        rep_ok = H.read_json(os.path.join(film_ok, 'out', 'mix.qa.json'))
        sync_c = next(c for c in rep_ok['checks'] if c['id'] == 'audio.sync')
        self.assertEqual(sync_c['status'], 'pass')
        self.assertEqual(sync_c['evidence']['inputTrack'], 'sfx')
        self.assertEqual(sync_c['evidence']['path'], 'actor')
        self.assertLess(abs(sync_c['evidence']['offsetFrames']), 1.0)

        # 3) 偏移 +3 帧：经 Node 入口 tools/audio/qa.mjs 拦截，返回退出码 4 且 hardFailures 含 audio.sync
        sfx_late = _shift_audio(self.sfx, 3.0)
        sfx_late_st = np.column_stack([sfx_late, sfx_late]) * 0.65
        mix_late, g_l, _ = MX.loudness_to(D.fade(bed + sfx_late_st, 0.02, 0.05), -14.0, -1.5)
        mix_late[0] = mix_late[-1] = 0.0
        late_wav = H.write_wav(os.path.join(film_ok, 'out', 'mix_late.wav'), mix_late)
        late_stem = H.write_wav(os.path.join(film_ok, 'out', 'stems', 'sfx_late.wav'), sfx_late_st * (10.0 ** (g_l / 20.0)))

        r_node_fail = H.run(
            [
                'node', 'tools/audio/qa.mjs',
                '--film', film_ok, '--wav', late_wav,
                '--kinematics', self.kin_path, '--sync-stem', late_stem,
                '--no-report', '--json',
            ],
            BEIMING_PY=sys.executable,
        )
        self.assertEqual(r_node_fail.returncode, 4, r_node_fail.stderr)
        env_fail = H.envelope(r_node_fail)
        self.assertIn('audio.sync', env_fail['data']['summary']['hardFailures'])

        # 4) 核对 Node qa.mjs 与 Python qa.py 同步选项对齐
        r_opts = H.run(['node', '-e', "import('./tools/audio/qa.mjs').then(m => console.log(JSON.stringify(Object.keys(m.command.options))));"])
        self.assertEqual(r_opts.returncode, 0, r_opts.stderr)
        opts = set(json.loads(r_opts.stdout))
        for k in ('kinematics', 'video', 'sync-stem', 'sync-path', 'sync-fps-mode', 'sync-warn-frames', 'sync-fail-frames'):
            self.assertIn(k, opts)

        # 5) 缺少遥测文件退出 3
        r_miss = H.run(['python', '-m', 'engine.audio.qa', '--film', film_ok, '--kinematics', os.path.join(self.td, 'missing.json'), '--no-report', '--json'])
        self.assertEqual(r_miss.returncode, 3)
        self.assertEqual(H.envelope(r_miss)['error']['code'], 'env.kinematics-missing')


if __name__ == '__main__':
    unittest.main()
