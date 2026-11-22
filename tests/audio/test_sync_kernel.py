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
        # 1) 构造带连续镜头微漂移的一拍二偶/奇相重复帧视频帧差（24 fps 连续运动不触发，12 fps 呈现 [val, 0, val, 0] 交替零梳）
        t_f = np.arange(n_frames, dtype=np.float64)
        pan = 8.0 * (2.0 * np.abs(2.0 * ((t_f / 40.0) - np.floor(t_f / 40.0 + 0.5))) - 1.0)
        frames_anim = self.frames + pan[:, None]
        d1_24_anim, _ = SK.video_motion_curves(frames_anim)
        self.assertFalse(SK.apply_on_twos_guard(d1_24_anim, force=False)[1])

        fr12_even = np.repeat(frames_anim[0::2], 2, axis=0)[:n_frames]
        fr12_odd = np.repeat(frames_anim[1::2], 2, axis=0)[:n_frames]
        d1_even, _ = SK.video_motion_curves(fr12_even)
        d1_odd, _ = SK.video_motion_curves(fr12_odd)

        # 未加守卫时 d1_even 呈现偶相 12 Hz 零值梳；奇偶相均可被自动检出
        guarded_ev, detected_ev = SK.apply_on_twos_guard(d1_even, force=False)
        guarded_od, detected_od = SK.apply_on_twos_guard(d1_odd, force=False)
        self.assertTrue(detected_ev)
        self.assertTrue(detected_od)
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
        self.assertEqual(res_ok['fps_mode'], '24fps', res_ok)
        self.assertFalse(res_ok['on_twos_detected'])
        self.assertFalse(res_ok['on_twos_guard_applied'])
        self.assertEqual(res_ok['status'], 'pass', res_ok)
        self.assertLess(abs(res_ok['offset_frames']), 1.0)

        res_bad = SK.evaluate_sync(_shift_audio(sfx, 3.0, fps=fps), sr=D.SR, video_path=mp4_path, video_metric='d1', input_track='sfx')
        self.assertEqual(res_bad['status'], 'fail', res_bad)
        self.assertGreater(res_bad['offset_frames'], 2.0)

        # 损坏视频文件走 sync_kernel 与 qa CLI 均应映射 contract.video-unreadable (exit 4)
        bad_mp4 = os.path.join(self.td, 'corrupt_real.mp4')
        with open(bad_mp4, 'wb') as f:
            f.write(b'not-a-valid-mp4-container-0000')
        wav_cor = H.write_wav(os.path.join(self.td, 'sfx_cor.wav'), np.column_stack([sfx, sfx]))
        r_cor_sk = H.run(['python', '-m', 'engine.audio.sync_kernel', '--audio', wav_cor, '--video', bad_mp4, '--json'])
        self.assertEqual(r_cor_sk.returncode, 4, r_cor_sk.stderr)
        self.assertEqual(H.envelope(r_cor_sk)['error']['code'], 'contract.video-unreadable')

        film_cor = os.path.join(self.td, 'film-corrupt-vid')
        H.film_json(film_cor, frames=nf, fps=fps, cuts=())
        mix_cor = H.write_wav(os.path.join(film_cor, 'out', 'mix.wav'), np.column_stack([sfx, sfx]) * 0.4)
        r_cor_qa = H.run(['python', '-m', 'engine.audio.qa', '--film', film_cor, '--wav', mix_cor, '--video', bad_mp4, '--no-report', '--json'])
        self.assertEqual(r_cor_qa.returncode, 4, r_cor_qa.stderr)
        self.assertEqual(H.envelope(r_cor_qa)['error']['code'], 'contract.video-unreadable')

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

    def test_review_fixes_finiteness_pause_on_twos_guard_kernel_and_cli_errors(self):
        from unittest import mock
        from engine.audio._cli import CliError

        # 1) P1-1: kinematics / motion 含 NaN/Inf 直接抛 ValueError；audio 含 NaN/Inf 返回有限 valid=False 且可 json.dumps(allow_nan=False)
        for bad_val in (float('nan'), float('inf')):
            kin_nan = json.loads(json.dumps(self.kin))
            kin_nan['tracks']['hero']['x'][10] = bad_val
            with self.assertRaises(ValueError):
                SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=kin_nan, motion_path='actor')
            kin_scr_nan = {'fps': 24, 'dur': 1.0, 'tracks': {'screen': {'motion': [0.1, bad_val] + [0.1] * 22}}}
            with self.assertRaises(ValueError):
                SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=kin_scr_nan, motion_path='screen')
            with self.assertRaises(ValueError):
                SK.evaluate_sync(self.sfx, sr=D.SR, motion=np.array([0.0, 1.0, bad_val, 0.0]))

        aud_nan = self.sfx.copy()
        aud_nan[1234] = float('nan')
        aud_inf = self.sfx.copy()
        aud_inf[2345] = float('inf')
        for bad_aud in (aud_nan, aud_inf):
            flux = SK.onset_flux(bad_aud, D.SR, fps=24.0)
            self.assertTrue(np.all(np.isfinite(flux)))
            self.assertTrue(np.all(flux == 0.0))
            xc = SK.xcorr_offset_frames(np.array([0.0, 1.0, 0.0, 0.5, 0.0]), np.array([0.0, float('nan'), 1.0, 0.0, 0.0]))
            self.assertFalse(xc['valid'])
            self.assertTrue(all(np.isfinite(xc[k]) for k in ('offset_frames', 'offset_ms', 'peak_corr', 'peak_snr')))
            r_nan = SK.evaluate_sync(bad_aud, sr=D.SR, kinematics=self.kin, input_track='sfx')
            self.assertEqual(r_nan['status'], 'warn')
            self.assertFalse(r_nan['valid'])
            json.dumps(r_nan, allow_nan=False)

        # float WAV（SoundFile FLOAT）保留 NaN 经 sync_kernel CLI 检查不崩 --report
        import soundfile as sf
        wav_nan_f = os.path.join(self.td, 'sfx_nan_f32.wav')
        sf.write(wav_nan_f, np.column_stack([aud_nan, aud_nan]), D.SR, subtype='FLOAT')
        rep_nan = os.path.join(self.td, 'nan_sync_report.json')
        r_cli_nan = H.run(['python', '-m', 'engine.audio.sync_kernel', '--audio', wav_nan_f, '--kinematics', self.kin_path, '--report', rep_nan, '--json'])
        self.assertEqual(r_cli_nan.returncode, 0, r_cli_nan.stderr)
        env_nan = H.envelope(r_cli_nan)
        self.assertFalse(env_nan['data']['valid'])
        json.dumps(H.read_json(rep_nan), allow_nan=False)

        # CLI 对含 NaN kinematics 与显式 fps=0 均返回 exit 4（contract.sync-input）
        wav_sfx = H.write_wav(os.path.join(self.td, 'sfx_check.wav'), np.column_stack([self.sfx, self.sfx]))
        bad_kin_p = os.path.join(self.td, 'nan_kin.json')
        with open(bad_kin_p, 'w', encoding='utf-8') as f:
            json.dump({'fps': 24, 'dur': 1.0, 'tracks': {'screen': {'motion': [0.1, float('nan')] + [0.1] * 22}}}, f, allow_nan=True)
        bad_kin_p2 = os.path.join(self.td, 'bad_fps_kin.json')
        with open(bad_kin_p2, 'w', encoding='utf-8') as f:
            json.dump({'fps': 0, 'dur': 1.0, 'tracks': {'screen': {'motion': [0.1] * 24}}}, f)
        for bad_kp in (bad_kin_p, bad_kin_p2):
            r_bad_kin = H.run(['python', '-m', 'engine.audio.sync_kernel', '--audio', wav_sfx, '--kinematics', bad_kp, '--json'])
            self.assertEqual(r_bad_kin.returncode, 4, r_bad_kin.stderr)
            self.assertEqual(H.envelope(r_bad_kin)['error']['code'], 'contract.sync-input')

        # 2) P2-4: 显式 fps=0 不可静默 fallback 到 24.0；qa.check_sync 直调校验互斥
        with self.assertRaises(ValueError):
            SK.load_kinematics({'fps': 0, 'dur': 1.0, 'tracks': {'screen': {'motion': [0.1] * 24}}})
        with self.assertRaises(ValueError):
            SK.evaluate_sync(self.sfx, sr=D.SR, kinematics=self.kin, fps=0)
        with self.assertRaises(CliError) as cm_ctx:
            QA.check_sync(wav_sfx, kinematics=self.kin_path, video=wav_sfx)
        self.assertEqual(cm_ctx.exception.code, 'usage.conflicting-visual')

        # 3) P1-2 & P2-3: RuntimeError → exit 4 (contract.video-unreadable)；TimeoutError → exit 124 (timeout.video-decode)；阻塞超时真实终止
        from engine.audio._cli import exit_code_for
        fake_vid = os.path.join(self.td, 'fake_vid.mp4')
        with open(fake_vid, 'wb') as f:
            f.write(b'corrupt-bytes')
        with mock.patch.object(SK, 'evaluate_sync', side_effect=RuntimeError('decode failed')):
            with self.assertRaises(CliError) as cm_rt_sk:
                SK.main_cli(SK.make_parser().parse_args(['--audio', wav_sfx, '--video', fake_vid]), mock.MagicMock())
            self.assertEqual(cm_rt_sk.exception.code, 'contract.video-unreadable')
            self.assertEqual(exit_code_for(cm_rt_sk.exception.code), 4)
            with self.assertRaises(CliError) as cm_rt_qa:
                QA.check_sync(wav_sfx, video=fake_vid)
            self.assertEqual(cm_rt_qa.exception.code, 'contract.video-unreadable')
            self.assertEqual(exit_code_for(cm_rt_qa.exception.code), 4)
        with mock.patch.object(SK, 'evaluate_sync', side_effect=TimeoutError('timed out')):
            with self.assertRaises(CliError) as cm_to_sk:
                SK.main_cli(SK.make_parser().parse_args(['--audio', wav_sfx, '--video', fake_vid]), mock.MagicMock())
            self.assertEqual(cm_to_sk.exception.code, 'timeout.video-decode')
            self.assertEqual(exit_code_for(cm_to_sk.exception.code), 124)
            with self.assertRaises(CliError) as cm_to_qa:
                QA.check_sync(wav_sfx, video=fake_vid)
            self.assertEqual(cm_to_qa.exception.code, 'timeout.video-decode')
            self.assertEqual(exit_code_for(cm_to_qa.exception.code), 124)

        # 真实子进程阻塞超时（stub ffmpeg 阻塞）验证 extract_video_frames deadline 必抛 TimeoutError 且终止进程树
        if os.name == 'nt':
            stub_bin = os.path.join(self.td, 'ff_sleep.bat')
            with open(stub_bin, 'w', encoding='utf-8') as f:
                f.write(f'@"{sys.executable}" -c "import time; time.sleep(30)"\r\n')
        else:
            stub_bin = os.path.join(self.td, 'ff_sleep.sh')
            with open(stub_bin, 'w', encoding='utf-8') as f:
                f.write('#!/bin/sh\nsleep 30\n')
            os.chmod(stub_bin, 0o755)
        with mock.patch('engine.audio._env.ffmpeg', return_value=stub_bin), mock.patch('engine.audio._env.ffprobe', return_value=''):
            with self.assertRaises(TimeoutError):
                SK.extract_video_frames(fake_vid, timeout_s=0.15)

        # 4) P1-3: 60% 连续静置留白 + 40% 连续运动的 24 fps 曲线不得误判为一拍二
        buf_pause = np.zeros((240, 32), dtype=np.float64)
        for i in range(96, 192):
            buf_pause[i] = (i - 96) * 2.0
        d1_pause, _ = SK.video_motion_curves(buf_pause)
        _, det_pause = SK.apply_on_twos_guard(d1_pause, force=False)
        self.assertFalse(det_pause, '连续静置留白不应误判为一拍二')
        r_pause = SK.evaluate_sync(self.sfx, sr=D.SR, motion=d1_pause, fps=24.0, fps_mode='auto', input_track='sfx')
        self.assertEqual(r_pause['fps_mode'], '24fps')
        self.assertFalse(r_pause['on_twos_detected'])

        # 5) P2-5 ②: 连续平移动画 + 12 Hz 伴随底床场景下，[0.25, 0.5, 0.25] 守卫 vs [0, 1, 0] 必须拉出硬差距（改回 [0,1,0] 必挂）
        nf = 240
        tf = np.arange(nf)
        tri = 60.0 * (2.0 * np.abs(2.0 * ((tf / 40.0) - np.floor(tf / 40.0 + 0.5))) - 1.0) + 100.0
        fr_pan = np.tile(tri[:, None], (1, 32))
        r_pan = np.random.default_rng(2026)
        sfx_pan = np.zeros(int(round(10.0 * D.SR)), dtype=np.float64)
        for idx, fi in enumerate([18, 37, 56, 79, 102, 125, 148, 171, 194, 217]):
            fr_pan[fi:] += (35.0 if idx % 2 == 0 else -35.0)
            s0 = int(round(fi / 24.0 * D.SR))
            ln = int(round(0.055 * D.SR))
            tt = np.arange(ln) / float(D.SR)
            sfx_pan[s0:s0 + ln] += D.bp(r_pan.standard_normal(ln), 1200.0, 9500.0, 2) * np.minimum(1.0, tt / 0.0015) * np.exp(-tt / 0.012) * 0.85
        ts = np.arange(len(sfx_pan)) / float(D.SR)
        bed_12 = np.maximum(0.0, np.sin(2.0 * np.pi * 12.0 * ts - np.pi / 2.0)) ** 6
        sfx_comb = sfx_pan + D.bp(r_pan.standard_normal(len(sfx_pan)), 2500.0, 9500.0, 2) * bed_12 * 0.25

        fr_pan12_o = np.r_[fr_pan[:1], np.repeat(fr_pan[1::2], 2, axis=0)][:nf]
        d1_pan12_o, _ = SK.video_motion_curves(fr_pan12_o)
        d1_pan12_g, det_pan12 = SK.apply_on_twos_guard(d1_pan12_o, force=False)
        self.assertTrue(det_pan12, '12fps 奇相重复帧应检出一拍二')
        errs_guarded = [abs(SK.estimate_offset_frames(d1_pan12_g, _shift_audio(sfx_comb, k), sr=D.SR, fps=24.0)['offset_frames'] - k) for k in (0, 1, -1, 2, -2, 4, -4)]
        # 验证 ON_TWOS_KERNEL 真正压住了 12 Hz 梳状跳跃（对比 [0,1,0] 的 6.0f 跳变；[0.25,0.5,0.25] 最大误差 < 1.25f，而 [0,1,0] > 2.0f）
        self.assertLess(max(errs_guarded), 1.35, f'ON_TWOS_KERNEL 未有效抑制 12 Hz 伪峰跳变: {errs_guarded}')
        d1_pan12_noop = np.convolve(d1_pan12_o, np.array([0.0, 1.0, 0.0]), mode='same')
        errs_noop = [abs(SK.estimate_offset_frames(d1_pan12_noop, _shift_audio(sfx_comb, k), sr=D.SR, fps=24.0)['offset_frames'] - k) for k in (0, 1, -1, 2, -2, 4, -4)]
        self.assertGreater(max(errs_noop), 2.5, f'对照组 [0,1,0] 应出现明显 12Hz 梳状跳变: {errs_noop}')


if __name__ == '__main__':
    unittest.main()
