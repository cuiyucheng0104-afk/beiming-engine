# -*- coding: utf-8 -*-
"""情绪导引乐谱与 ACE-Step 1.5 Cover 配乐生成（engine/audio/music_gen.py + tools/audio/music.mjs）单元测试。

覆盖：
  · plan_sections_from_film 与 build_guide_score：叙事能量弧线（终章 RMS 显著高于开场）、全曲中段零死寂断档、
    精确 N(dur) 立体声样本、-3.0 dBFS 峰值归一、首尾归零无爆音、同种子逐样本完全一致；
  · generate_cover 对接本地临时 ThreadingHTTPServer 模拟的 ACE-Step 1.5 服务（POST /release_task、POST /query_result、
    GET /v1/audio、GET /health、GET /v1/stats）：校验 multipart 上传含 src_audio 与 task_type=cover、跨采样率 soxr 重采样、
    长度裁剪/平滑补尾至精确 N(dur) @ 48 kHz PCM_24、磁盘缓存读写、二次 --offline 命中缓存（cache == 'hit'）、
    离线缓存未命中退出码 3、未配地址退出码 3、D11 AIGC 元数据完全合规；
  · Node 入口 tools/audio/music.mjs：与 Python argparse 选项 1:1 严格对齐、--help 退出 0 且不起 Python、
    未知选项 --json 退出 2（usage.unknown-option）、guide 与 build --provider guide --json 全链路闭环。

用法（仓库根）：python -m unittest discover -s tests/audio -p "test_music_gen.py"
"""
from email import message_from_bytes
from email.policy import default as email_default_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
import shutil
import sys
import threading
import unittest
import urllib.parse

import numpy as np
import soundfile as sf

import _audiotest as H
from engine.audio import music_gen as MG
from engine.audio._cli import CliError


def _parse_multipart_body(content_type: str, raw_body: bytes) -> tuple[dict[str, str], dict[str, bytes]]:
    raw_msg = f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n'.encode('utf-8') + raw_body
    msg = message_from_bytes(raw_msg, policy=email_default_policy)
    fields: dict[str, str] = {}
    files: dict[str, bytes] = {}
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        filename = part.get_filename()
        payload = part.get_payload(decode=True) or b''
        if not name:
            continue
        if filename is not None:
            files[name] = payload
        else:
            fields[name] = payload.decode('utf-8', errors='replace')
    return fields, files


class _MockAceStepServer:
    """本机回环临时 ACE-Step 1.5 HTTP 模拟服务（支持健康探测、Cover 任务提交、分步轮询与音频下载）。"""

    def __init__(self, *, gen_sr: int = 44100, gen_dur: float = 3.6, health_404: bool = False, direct_json: bool = False):
        self.gen_sr = gen_sr
        self.gen_dur = gen_dur
        self.health_404 = health_404
        self.direct_json = direct_json
        self.submissions: list[dict] = []
        self.polls = 0
        self.downloads = 0
        self._tasks: dict[str, int] = {}
        self._lock = threading.Lock()

        # 预生成一段 44.1 kHz 单声道温暖和弦测试音频（短于或异于 48 kHz 目标，验证 soxr 重采样、转立体声与平滑补尾/裁剪）
        n = int(round(gen_dur * gen_sr))
        t = np.arange(n, dtype=np.float64) / float(gen_sr)
        wave = (
            0.35 * np.sin(2.0 * math.pi * 293.66 * t)
            + 0.25 * np.sin(2.0 * math.pi * 440.00 * t)
            + 0.18 * np.sin(2.0 * math.pi * 587.33 * t)
        )
        buf = io.BytesIO()
        sf.write(buf, wave.astype(np.float32), gen_sr, format='WAV', subtype='PCM_16')
        self._wav_bytes = buf.getvalue()

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def _send_json(self, status: int, obj) -> None:
                raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path == '/health':
                    if outer.health_404:
                        self._send_json(404, {'error': 'no /health'})
                        return
                    self._send_json(200, {'code': 200, 'data': {'status': 'ok', 'model': 'acestep-v15'}})
                    return
                if parsed.path == '/v1/stats':
                    self._send_json(200, {'status': 'ready', 'queue': 0})
                    return
                if parsed.path == '/v1/audio':
                    qs = urllib.parse.parse_qs(parsed.query)
                    if not qs.get('path'):
                        self._send_json(400, {'error': 'missing path'})
                        return
                    with outer._lock:
                        outer.downloads += 1
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/wav')
                    self.send_header('Content-Length', str(len(outer._wav_bytes)))
                    self.end_headers()
                    self.wfile.write(outer._wav_bytes)
                    return
                self._send_json(404, {'error': 'not found'})

            def do_POST(self):
                parsed = urllib.parse.urlparse(self.path)
                length = int(self.headers.get('Content-Length') or '0')
                body = self.rfile.read(length)
                ctype = self.headers.get('Content-Type') or ''

                if parsed.path == '/release_task':
                    fields, files = _parse_multipart_body(ctype, body)
                    with outer._lock:
                        tid = f'mock-task-{len(outer.submissions) + 1}'
                        outer.submissions.append({'task_id': tid, 'fields': fields, 'files': files})
                        outer._tasks[tid] = 0
                    if outer.direct_json:
                        self._send_json(200, {'task_id': tid, 'status': 0})
                    else:
                        self._send_json(200, {'code': 200, 'data': {'task_id': tid, 'status': 0}, 'error': None})
                    return

                if parsed.path == '/query_result':
                    doc = json.loads(body.decode('utf-8'))
                    tlist = doc.get('task_id_list') or []
                    tid = tlist[0] if tlist else ''
                    with outer._lock:
                        outer.polls += 1
                        cnt = outer._tasks.get(tid, 0) + 1
                        outer._tasks[tid] = cnt
                    if cnt < 2:
                        row = {'task_id': tid, 'status': 0, 'result': '[]'}
                    else:
                        res_str = json.dumps([{'file': '/v1/audio?path=%2Fmock%2Fgenerated_cover.wav', 'status': 1}])
                        row = {'task_id': tid, 'status': 1, 'result': res_str}
                    if outer.direct_json:
                        self._send_json(200, [row])
                    else:
                        self._send_json(200, {'code': 200, 'data': [row], 'error': None})
                    return

                self._send_json(404, {'error': 'unknown endpoint'})

        self._httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self._httpd.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5.0)


class GuideScoreTests(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('music-guide')

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_plan_sections_and_emotional_lift(self):
        film_dir = os.path.join(self.td, 'dawn')
        H.film_json(
            film_dir,
            frames=240,
            fps=24,
            cuts=(60, 132, 168),
            events=[
                {'id': 'ev1', 'frame': 72, 'cue': True},
                {'id': 'ev2', 'frame': 96, 'cue': True},
                {'id': 'ev3', 'frame': 180, 'cue': True},
            ],
        )
        plan = MG.plan_sections_from_film(film_dir)
        self.assertEqual(plan['dur'], 10.0)
        self.assertEqual(plan['fps'], 24)
        self.assertEqual(plan['key'], 'D')
        self.assertEqual(plan['scale'], 'major')
        self.assertEqual(plan['bpm'], 96.0)
        self.assertEqual(len(plan['sections']), 4)

        secs = plan['sections']
        self.assertAlmostEqual(secs[0]['t0'], 0.0)
        self.assertAlmostEqual(secs[-1]['t1'], 10.0)
        for a, b in zip(secs, secs[1:]):
            self.assertAlmostEqual(a['t1'], b['t0'])
            self.assertTrue(isinstance(a['chord_deg'], list) and len(a['chord_deg']) >= 1)

        # 叙事弧线校验：开场铺垫 -> 展开推进 -> 高潮前悬停呼吸 -> 终章高潮抬升
        self.assertAlmostEqual(secs[0]['energy'], 0.35)
        self.assertGreater(secs[1]['energy'], secs[0]['energy'])
        self.assertLess(secs[2]['energy'], secs[-1]['energy'])
        self.assertAlmostEqual(secs[-1]['energy'], 0.92)
        self.assertEqual(secs[-1]['mood'], 'climax')

        guide, meta = MG.build_guide_score(plan, seed=42)
        self.assertEqual(guide.shape, (H.N(10.0), 2))
        self.assertTrue(np.all(np.isfinite(guide)))
        self.assertEqual(float(np.max(np.abs(guide[0]))), 0.0)
        self.assertEqual(float(np.max(np.abs(guide[-1]))), 0.0)

        # 峰值严格归一至 -3.0 dBFS
        peak_db = 20.0 * math.log10(float(np.max(np.abs(guide))))
        self.assertAlmostEqual(peak_db, -3.0, places=2)

        # 终章 RMS 显著高于开场 RMS（情绪高潮抬升）
        s0_a, s0_b = H.N(secs[0]['t0']), H.N(secs[0]['t1'])
        sf_a, sf_b = H.N(secs[-1]['t0']), H.N(secs[-1]['t1'])
        intro_rms_db = 20.0 * math.log10(float(np.sqrt(np.mean(guide[s0_a:s0_b] ** 2))))
        finale_rms_db = 20.0 * math.log10(float(np.sqrt(np.mean(guide[sf_a:sf_b] ** 2))))
        self.assertGreater(
            finale_rms_db,
            intro_rms_db + 4.0,
            f'终章 RMS ({finale_rms_db:.2f} dBFS) 应显著高于开场 ({intro_rms_db:.2f} dBFS)',
        )

        # 全曲内部 [0.15s, dur - 0.20s] 逐 100ms 滑动窗检查：绝无静音死谷或断片
        win = H.N(0.10)
        hop = H.N(0.05)
        interior = guide[H.N(0.15):H.N(9.80)]
        win_dbs = [
            20.0 * math.log10(max(float(np.sqrt(np.mean(interior[i:i + win] ** 2))), 1e-12))
            for i in range(0, len(interior) - win + 1, hop)
        ]
        self.assertGreater(min(win_dbs), -36.0, f'导引轨中段出现静音断档：最低 100ms 窗 {min(win_dbs):.2f} dBFS')

        # 确定性可重复：相同种子逐样本相等，不同种子波形不同
        guide_again, _ = MG.build_guide_score(plan, seed=42)
        self.assertTrue(np.array_equal(guide, guide_again))
        guide_diff, _ = MG.build_guide_score(plan, seed=77)
        self.assertFalse(np.array_equal(guide, guide_diff))
        self.assertEqual(meta['samples'], H.N(10.0))

    def test_single_and_two_shot_films_and_music_json(self):
        f1 = os.path.join(self.td, 'one_shot')
        H.film_json(f1, frames=144, fps=24, cuts=())
        with open(os.path.join(f1, 'music.json'), 'w', encoding='utf-8') as f:
            json.dump({'key': 'Am', 'bpm': 108}, f)
        p1 = MG.plan_sections_from_film(f1)
        self.assertEqual((p1['key'], p1['scale'], p1['bpm']), ('A', 'minor', 108.0))
        self.assertGreaterEqual(len(p1['sections']), 2)
        self.assertGreater(p1['sections'][-1]['energy'], p1['sections'][0]['energy'])

        g1, _ = MG.build_guide_score(p1, seed=11)
        self.assertEqual(g1.shape, (H.N(6.0), 2))


class CoverApiAndCacheTests(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('music-cover')
        self.film_dir = os.path.join(self.td, 'film')
        H.film_json(self.film_dir, frames=96, fps=24, cuts=(48,))
        self.plan = MG.plan_sections_from_film(self.film_dir)
        self.guide_st, _ = MG.build_guide_score(self.plan, seed=42)
        self.guide_wav = H.write_wav(os.path.join(self.td, 'guide.wav'), self.guide_st)

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_acestep_mock_cover_resample_cache_offline_and_d11(self):
        cache_dir = os.path.join(self.td, 'cache')
        out_wav = os.path.join(self.td, 'out', 'music.wav')
        prompt = 'cinematic orchestral strings and harp, soaring finale, instrumental'

        with _MockAceStepServer(gen_sr=44100, gen_dur=3.3) as srv:
            # Probe 在线检查（退出码 0 对应）
            p_res = MG.probe_endpoint(endpoint=srv.url)
            self.assertTrue(p_res['online'])
            self.assertEqual(p_res['probePath'], '/health')

            # 第一次生成：走网络 Cover API -> 缓存未命中（miss）
            res1 = MG.generate_cover(
                self.guide_wav,
                prompt=prompt,
                lyrics='[inst]',
                dur=4.0,
                endpoint=srv.url,
                cover_strength=0.45,
                steps=8,
                guidance_scale=4.5,
                seed=42,
                provider='acestep',
                cache_dir=cache_dir,
                out_wav=out_wav,
            )
            self.assertEqual(res1['cache'], 'miss')
            self.assertEqual(res1['samples'], H.N(4.0))
            self.assertAlmostEqual(res1['duration'], 4.0)
            self.assertEqual(res1['aigc'], {
                'contains': True,
                'kinds': ['music'],
                'tools': ['ACE-Step-1.5'],
                'note': '配乐由 ACE-Step 1.5 Cover 模式依据程序化导引轨生成',
            })

            # 核验服务端收到的 multipart/form-data 字段与导引 WAV 字节流
            self.assertEqual(len(srv.submissions), 1)
            sub = srv.submissions[0]
            self.assertEqual(sub['fields']['task_type'], 'cover')
            self.assertEqual(sub['fields']['prompt'], prompt)
            self.assertEqual(sub['fields']['lyrics'], '[inst]')
            self.assertEqual(sub['fields']['inference_steps'], '8')
            self.assertEqual(sub['fields']['thinking'], 'false')
            self.assertEqual(sub['fields']['audio_format'], 'wav')
            self.assertAlmostEqual(float(sub['fields']['audio_cover_strength']), 0.45, places=4)
            self.assertAlmostEqual(float(sub['fields']['guidance_scale']), 4.5, places=3)
            self.assertIn('src_audio', sub['files'])
            up_audio, up_sr = sf.read(io.BytesIO(sub['files']['src_audio']), always_2d=True)
            self.assertEqual((up_sr, up_audio.shape), (48000, (H.N(4.0), 2)))
            self.assertGreaterEqual(srv.polls, 2)
            self.assertEqual(srv.downloads, 1)

        # 验证输出 WAV 规格：48 kHz 立体声 PCM_24、精确 N(4.0) 样本、首尾严格 0.0
        info = sf.info(out_wav)
        self.assertEqual((info.samplerate, info.channels, info.frames, info.subtype), (48000, 2, H.N(4.0), 'PCM_24'))
        w1, _ = sf.read(out_wav, always_2d=True)
        self.assertEqual(float(np.max(np.abs(w1[0]))), 0.0)
        self.assertEqual(float(np.max(np.abs(w1[-1]))), 0.0)

        # 验证缓存目录结构：<key>.wav + <key>.json
        key = res1['key']
        self.assertTrue(os.path.isfile(os.path.join(cache_dir, f'{key}.wav')))
        meta_json = H.read_json(os.path.join(cache_dir, f'{key}.json'))
        self.assertEqual(meta_json['key'], key)
        self.assertEqual(meta_json['aigc'], MG.AIGC_ACESTEP)

        # 模拟服务已关闭！第二次调用开启 offline=True：直接命中本地缓存（cache == 'hit'），零网络请求！
        out_wav2 = os.path.join(self.td, 'out', 'music_cached.wav')
        res2 = MG.generate_cover(
            self.guide_wav,
            prompt=prompt,
            lyrics='[inst]',
            dur=4.0,
            cover_strength=0.45,
            steps=8,
            guidance_scale=4.5,
            seed=42,
            provider='acestep',
            cache_dir=cache_dir,
            out_wav=out_wav2,
            offline=True,
        )
        self.assertEqual(res2['cache'], 'hit')
        self.assertEqual(res2['key'], key)
        w2, _ = sf.read(out_wav2, always_2d=True)
        self.assertTrue(np.array_equal(w1, w2))

        # 离线模式下修改种子（缓存未命中）：抛 CliError 且 exit_code == 3
        with self.assertRaises(CliError) as cm_off:
            MG.generate_cover(
                self.guide_wav,
                prompt=prompt,
                dur=4.0,
                seed=999,
                provider='acestep',
                cache_dir=cache_dir,
                offline=True,
            )
        self.assertEqual(cm_off.exception.code, 'env.music-offline')
        self.assertEqual(cm_off.exception.exit_code, 3)

    def test_env_endpoint_fallback_stats_probe_and_long_trim(self):
        # 测试 /health 404 时回退 /v1/stats、直接 JSON 载荷、超长音频裁剪与 BEIMING_ACESTEP_URL 环境变量解析
        with _MockAceStepServer(gen_sr=24000, gen_dur=5.8, health_404=True, direct_json=True) as srv:
            old_env = os.environ.get('BEIMING_ACESTEP_URL')
            os.environ['BEIMING_ACESTEP_URL'] = srv.url
            try:
                p_res = MG.probe_endpoint()
                self.assertEqual(p_res['probePath'], '/v1/stats')
                out_wav = os.path.join(self.td, 'trimmed.wav')
                res = MG.generate_cover(
                    self.guide_st,
                    prompt='warm folk flute and strings',
                    dur=4.0,
                    provider='acestep',
                    out_wav=out_wav,
                )
                self.assertEqual(res['samples'], H.N(4.0))
                w, sr = sf.read(out_wav, always_2d=True)
                self.assertEqual((sr, w.shape), (48000, (H.N(4.0), 2)))
            finally:
                if old_env is None:
                    os.environ.pop('BEIMING_ACESTEP_URL', None)
                else:
                    os.environ['BEIMING_ACESTEP_URL'] = old_env

    def test_missing_endpoint_and_unreachable_probe_exit_3(self):
        old_env = os.environ.pop('BEIMING_ACESTEP_URL', None)
        try:
            with self.assertRaises(CliError) as cm_no_ep:
                MG.generate_cover(self.guide_st, prompt='test', dur=4.0, provider='acestep')
            self.assertEqual(cm_no_ep.exception.code, 'env.music-endpoint')
            self.assertEqual(cm_no_ep.exception.exit_code, 3)

            closed_port = MG._pick_ephemeral_port()
            with self.assertRaises(CliError) as cm_unreach:
                MG.probe_endpoint(endpoint=f'http://127.0.0.1:{closed_port}', timeout_s=1.5)
            self.assertEqual(cm_unreach.exception.exit_code, 3)
        finally:
            if old_env is not None:
                os.environ['BEIMING_ACESTEP_URL'] = old_env

    def test_ssh_host_rejects_option_like_or_whitespace_and_inserts_double_dash(self):
        """P2：--ssh 以 - 开头或含空白会被 OpenSSH 当选项解析（-oProxyCommand=…），必须在起进程前以 usage 错误（退出码 2）拒绝。"""
        for bad in ('-oProxyCommand=true', '-J evil', 'a b', 'host\tx'):
            with self.subTest(host=bad):
                with self.assertRaises(CliError) as cm:
                    with MG._resolve_acestep_base_url(None, bad, 8001):
                        self.fail('不应走到隧道已建立')
                self.assertEqual(cm.exception.exit_code, 2)

    @unittest.skipIf(os.name == 'nt', 'POSIX 可执行桩脚本测试')
    def test_ssh_port_forward_and_zero_orphan_cleanup(self):
        # 构造一个纯 Python 本地 TCP 转发桩替代 ssh 二进制：记录自身 PID 与命令行参数，验证 Cover 生成与退出后 0 残留进程
        bin_dir = os.path.join(self.td, 'mock_bin')
        os.makedirs(bin_dir, exist_ok=True)
        pid_file = os.path.join(self.td, 'ssh_stub.json')
        ssh_stub = os.path.join(bin_dir, 'ssh')
        stub_code = (
            f'#!{sys.executable}\n'
            'import json, os, select, signal, socket, sys, threading\n'
            'args = sys.argv[1:]\n'
            'spec = args[args.index("-L") + 1]\n'
            '_, lport, _, rport = spec.split(":")\n'
            f'open({pid_file!r}, "w", encoding="utf-8").write(json.dumps({{"pid": os.getpid(), "args": args}}))\n'
            'srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n'
            'srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n'
            'srv.bind(("127.0.0.1", int(lport)))\n'
            'srv.listen(16)\n'
            'stop = False\n'
            'def _bye(*_):\n'
            '    global stop\n'
            '    stop = True\n'
            '    try: srv.close()\n'
            '    except OSError: pass\n'
            '    sys.exit(0)\n'
            'signal.signal(signal.SIGTERM, _bye)\n'
            'def _pipe(a, b):\n'
            '    try:\n'
            '        while True:\n'
            '            d = a.recv(65536)\n'
            '            if not d: break\n'
            '            b.sendall(d)\n'
            '    except OSError: pass\n'
            '    finally:\n'
            '        for s in (a, b):\n'
            '            try: s.close()\n'
            '            except OSError: pass\n'
            'while not stop:\n'
            '    r, _, _ = select.select([srv], [], [], 0.2)\n'
            '    if not r: continue\n'
            '    try: cli, _ = srv.accept()\n'
            '    except OSError: break\n'
            '    up = socket.create_connection(("127.0.0.1", int(rport)), timeout=5.0)\n'
            '    threading.Thread(target=_pipe, args=(cli, up), daemon=True).start()\n'
            '    threading.Thread(target=_pipe, args=(up, cli), daemon=True).start()\n'
        )
        with open(ssh_stub, 'w', encoding='utf-8') as f:
            f.write(stub_code)
        os.chmod(ssh_stub, 0o755)

        old_path = os.environ.get('PATH', '')
        old_url = os.environ.pop('BEIMING_ACESTEP_URL', None)
        os.environ['PATH'] = bin_dir + os.pathsep + old_path
        try:
            with _MockAceStepServer(gen_sr=48000, gen_dur=4.0) as srv:
                out_wav = os.path.join(self.td, 'via_ssh.wav')
                res = MG.generate_cover(
                    self.guide_st,
                    prompt='orchestral adventure via ssh tunnel',
                    dur=4.0,
                    ssh_host='mock-gpu-alias',
                    remote_port=srv.port,
                    provider='acestep',
                    out_wav=out_wav,
                )
                self.assertEqual(res['cache'], 'miss')
                self.assertTrue(os.path.isfile(out_wav))
                stub_meta = H.read_json(pid_file)
                self.assertIn('BatchMode=yes', stub_meta['args'])
                self.assertIn('ExitOnForwardFailure=yes', stub_meta['args'])
                self.assertIn('-N', stub_meta['args'])
                self.assertEqual(stub_meta['args'][-2:], ['--', 'mock-gpu-alias'])
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(stub_meta['pid']), 0)
        finally:
            os.environ['PATH'] = old_path
            if old_url is not None:
                os.environ['BEIMING_ACESTEP_URL'] = old_url


class NodeCliTests(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('music-cli')
        self.film_dir = os.path.join(self.td, 'film')
        H.film_json(self.film_dir, frames=96, fps=24, cuts=(48,))

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_node_cli_help_unknown_option_and_option_parity(self):
        if not shutil.which('node'):
            self.skipTest('需要 node')

        # 1) --help 退出 0，且即使指定不存在的解释器也不起 Python
        r_help = H.run(['node', 'tools/audio/music.mjs', '--help'], BEIMING_PY='/nonexistent-py-binary')
        self.assertEqual(r_help.returncode, 0, r_help.stderr)
        self.assertIn('audio:music', r_help.stdout)
        self.assertIn('--cover-strength', r_help.stdout)

        # 2) --no-such-flag --json 退出 2，输出标准 C2 usage.unknown-option 信封
        r_bad = H.run(['node', 'tools/audio/music.mjs', '--no-such-flag', '--json'], BEIMING_PY='/nonexistent-py-binary')
        self.assertEqual(r_bad.returncode, 2, r_bad.stderr)
        env_bad = H.envelope(r_bad)
        self.assertFalse(env_bad['ok'])
        self.assertEqual(env_bad['exitCode'], 2)
        self.assertEqual(env_bad['command'], 'audio:music')
        self.assertEqual(env_bad['error']['code'], 'usage.unknown-option')

        # 3) Node 声明选项与 Python ArgumentParser 选项严格 1:1 对齐
        r_opts = H.run([
            'node', '-e',
            "import('./tools/audio/music.mjs').then(m => console.log(JSON.stringify(Object.keys(m.command.options))));",
        ])
        self.assertEqual(r_opts.returncode, 0, r_opts.stderr)
        node_opts = set(json.loads(r_opts.stdout)) - {'help', 'version'}
        py_parser = MG.make_parser()
        py_opts = {
            s[2:] for act in py_parser._actions for s in act.option_strings
            if s.startswith('--') and s != '--help'
        }
        self.assertEqual(node_opts, py_opts)

    def test_node_cli_guide_build_and_probe(self):
        if not shutil.which('node'):
            self.skipTest('需要 node')

        # 1) guide 子命令
        out_guide = os.path.join(self.td, 'custom_guide.wav')
        r_g = H.run(
            ['node', 'tools/audio/music.mjs', 'guide', self.film_dir, '--out', out_guide, '--key', 'G', '--bpm', '100', '--json'],
            BEIMING_PY=sys.executable,
        )
        self.assertEqual(r_g.returncode, 0, r_g.stderr)
        env_g = H.envelope(r_g)
        self.assertTrue(env_g['ok'])
        self.assertEqual(env_g['command'], 'audio:music')
        self.assertEqual(env_g['data']['key'], 'G')
        self.assertEqual(env_g['data']['samples'], H.N(4.0))
        self.assertTrue(os.path.isfile(out_guide))

        # 2) build --provider guide --json 离线确定性构建
        out_mus = os.path.join(self.td, 'offline_music.wav')
        r_b = H.run(
            ['node', 'tools/audio/music.mjs', 'build', self.film_dir, '--provider', 'guide', '--out', out_mus, '--json'],
            BEIMING_PY=sys.executable,
        )
        self.assertEqual(r_b.returncode, 0, r_b.stderr)
        env_b = H.envelope(r_b)
        self.assertTrue(env_b['ok'])
        self.assertEqual(env_b['data']['cache'], 'guide')
        self.assertFalse(env_b['data']['aigc']['contains'])
        info = sf.info(out_mus)
        self.assertEqual((info.samplerate, info.channels, info.frames, info.subtype), (48000, 2, H.N(4.0), 'PCM_24'))

        # 3) build --provider acestep + probe 对接本地模拟服务
        with _MockAceStepServer(gen_sr=48000, gen_dur=4.0) as srv:
            r_p = H.run(
                ['node', 'tools/audio/music.mjs', 'probe', '--endpoint', srv.url, '--json'],
                BEIMING_PY=sys.executable,
            )
            self.assertEqual(r_p.returncode, 0, r_p.stderr)
            self.assertTrue(H.envelope(r_p)['data']['online'])

            out_ace = os.path.join(self.td, 'ace_music.wav')
            cache_dir = os.path.join(self.td, 'ace_cache')
            r_ace = H.run([
                'node', 'tools/audio/music.mjs', 'build', self.film_dir,
                '--provider', 'acestep', '--endpoint', srv.url,
                '--cache', cache_dir, '--out', out_ace, '--steps', '6', '--json',
            ], BEIMING_PY=sys.executable)
            self.assertEqual(r_ace.returncode, 0, r_ace.stderr)
            env_ace = H.envelope(r_ace)
            self.assertEqual(env_ace['data']['cache'], 'miss')
            self.assertEqual(env_ace['data']['aigc'], MG.AIGC_ACESTEP)

        # 服务关闭后 --offline 再次构建，验证 Node CLI 返回 cache == 'hit'
        r_hit = H.run([
            'node', 'tools/audio/music.mjs', 'build', self.film_dir,
            '--provider', 'acestep', '--cache', cache_dir, '--out', out_ace,
            '--steps', '6', '--offline', '--json',
        ], BEIMING_PY=sys.executable)
        self.assertEqual(r_hit.returncode, 0, r_hit.stderr)
        self.assertEqual(H.envelope(r_hit)['data']['cache'], 'hit')


if __name__ == '__main__':
    unittest.main()
